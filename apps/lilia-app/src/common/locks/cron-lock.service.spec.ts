import { CronLockService } from './cron-lock.service';

/**
 * Verrou distribué des crons, et garde `RUN_BACKGROUND_JOBS`.
 *
 * Le point sensible n'est pas le verrou lui-même mais **le moment** où la
 * variable d'environnement est lue. Elle l'était dans les décorateurs
 * `@Module`, qui s'évaluent à l'import du fichier — donc avant que
 * `ConfigModule.forRoot()` n'ait chargé le `.env`. Un
 * `RUN_BACKGROUND_JOBS=false` écrit dans un `.env` n'avait donc aucun effet,
 * et le processus web continuait d'exécuter les crons qu'on croyait éteints.
 *
 * Ces tests figent la lecture **tardive** : ils modifient `process.env` après
 * la construction du service, ce qui est exactement la situation que l'ancien
 * code ne savait pas gérer.
 */
describe('CronLockService', () => {
  const originalFlag = process.env.RUN_BACKGROUND_JOBS;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.RUN_BACKGROUND_JOBS;
    else process.env.RUN_BACKGROUND_JOBS = originalFlag;
  });

  /** Redis qui accorde toujours le verrou. */
  const grantingRedis = () =>
    ({
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    }) as any;

  describe('garde RUN_BACKGROUND_JOBS (B-2)', () => {
    it("n'exécute pas la tâche quand le flag passe à false APRÈS la construction", async () => {
      // L'ordre compte : le service existe déjà quand la variable arrive,
      // comme lorsque `ConfigModule` charge le `.env` après les décorateurs.
      const redis = grantingRedis();
      const service = new CronLockService(redis);
      process.env.RUN_BACKGROUND_JOBS = 'false';

      const task = jest.fn().mockResolvedValue('fait');
      const result = await service.runExclusively('un-job', 60, task);

      expect(task).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
      // Aucun verrou posé : inutile de réserver une clé pour ne rien faire.
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('exécute la tâche quand le flag est absent (défaut : on tourne)', async () => {
      // Le défaut est volontairement permissif : un déploiement qui oublie la
      // variable garde ses crons, plutôt que de perdre en silence l'expiration
      // des commandes impayées.
      const service = new CronLockService(grantingRedis());
      delete process.env.RUN_BACKGROUND_JOBS;

      const task = jest.fn().mockResolvedValue('fait');

      await expect(service.runExclusively('un-job', 60, task)).resolves.toBe(
        'fait',
      );
      expect(task).toHaveBeenCalledTimes(1);
    });

    it('réévalue le flag à chaque appel, sans mémoriser la première lecture', async () => {
      const service = new CronLockService(grantingRedis());
      const task = jest.fn().mockResolvedValue('fait');

      process.env.RUN_BACKGROUND_JOBS = 'false';
      await service.runExclusively('un-job', 60, task);
      expect(task).not.toHaveBeenCalled();

      process.env.RUN_BACKGROUND_JOBS = 'true';
      await service.runExclusively('un-job', 60, task);
      expect(task).toHaveBeenCalledTimes(1);
    });
  });

  describe('verrou distribué', () => {
    it("n'exécute pas la tâche si une autre instance détient le verrou", async () => {
      // `SET NX` rend `null` quand la clé existe déjà.
      const redis = { set: jest.fn().mockResolvedValue(null) } as any;
      const service = new CronLockService(redis);
      const task = jest.fn();

      await service.runExclusively('un-job', 60, task);

      expect(task).not.toHaveBeenCalled();
    });

    it('exécute quand même la tâche sans Redis (mono-instance)', async () => {
      // Une panne Redis ne doit pas éteindre l'expiration des commandes : le
      // doublon est moins grave que l'absence.
      const service = new CronLockService(undefined);
      const task = jest.fn().mockResolvedValue('fait');

      await expect(service.runExclusively('un-job', 60, task)).resolves.toBe(
        'fait',
      );
    });
  });
});
