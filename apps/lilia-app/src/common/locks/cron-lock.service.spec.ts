import { CronLockService } from './cron-lock.service';

/**
 * Verrou des crons (bail `CronLease`, lot 4), et garde `RUN_BACKGROUND_JOBS`.
 *
 * Le point sensible de la garde n'est pas le verrou lui-même mais **le moment**
 * où la variable d'environnement est lue. Elle l'était dans les décorateurs
 * `@Module`, qui s'évaluent à l'import du fichier — donc avant que
 * `ConfigModule.forRoot()` n'ait chargé le `.env`. Un
 * `RUN_BACKGROUND_JOBS=false` écrit dans un `.env` n'avait donc aucun effet,
 * et le processus web continuait d'exécuter les crons qu'on croyait éteints.
 *
 * Ces tests figent la lecture **tardive** : ils modifient `process.env` après
 * la construction du service. Le comportement du bail sur une vraie base est
 * couvert par `test/integration/cron-lease.int-spec.ts`.
 */
describe('CronLockService', () => {
  const originalFlag = process.env.RUN_BACKGROUND_JOBS;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.RUN_BACKGROUND_JOBS;
    else process.env.RUN_BACKGROUND_JOBS = originalFlag;
  });

  /** Base qui accorde toujours le bail : `RETURNING` rend le jeton posé. */
  const grantingPrisma = () => {
    const prisma = {
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    prisma.$queryRaw.mockImplementation(
      async (_sql: TemplateStringsArray, _job: string, holder: string) => [
        { holder },
      ],
    );
    return prisma as any;
  };

  describe('garde RUN_BACKGROUND_JOBS (B-2)', () => {
    it("n'exécute pas la tâche quand le flag passe à false APRÈS la construction", async () => {
      // L'ordre compte : le service existe déjà quand la variable arrive,
      // comme lorsque `ConfigModule` charge le `.env` après les décorateurs.
      const prisma = grantingPrisma();
      const service = new CronLockService(prisma);
      process.env.RUN_BACKGROUND_JOBS = 'false';

      const task = jest.fn().mockResolvedValue('fait');
      const result = await service.runExclusively('un-job', 60, task);

      expect(task).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
      // Aucun bail posé : inutile de réserver pour ne rien faire.
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('exécute la tâche quand le flag est absent (défaut : on tourne)', async () => {
      // Le défaut est volontairement permissif : un déploiement qui oublie la
      // variable garde ses crons, plutôt que de perdre en silence l'expiration
      // des commandes impayées.
      const service = new CronLockService(grantingPrisma());
      delete process.env.RUN_BACKGROUND_JOBS;

      const task = jest.fn().mockResolvedValue('fait');

      await expect(service.runExclusively('un-job', 60, task)).resolves.toBe(
        'fait',
      );
      expect(task).toHaveBeenCalledTimes(1);
    });

    it('réévalue le flag à chaque appel, sans mémoriser la première lecture', async () => {
      const service = new CronLockService(grantingPrisma());
      const task = jest.fn().mockResolvedValue('fait');

      process.env.RUN_BACKGROUND_JOBS = 'false';
      await service.runExclusively('un-job', 60, task);
      expect(task).not.toHaveBeenCalled();

      process.env.RUN_BACKGROUND_JOBS = 'true';
      await service.runExclusively('un-job', 60, task);
      expect(task).toHaveBeenCalledTimes(1);
    });
  });

  describe('bail en base', () => {
    it("n'exécute pas la tâche si une autre instance détient le bail", async () => {
      // Bail frais d'une autre instance : la condition `WHERE` échoue et
      // `RETURNING` ne rend aucune ligne.
      const prisma = grantingPrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      const service = new CronLockService(prisma);
      const task = jest.fn();

      await service.runExclusively('un-job', 60, task);

      expect(task).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('⚠️ ne libère QUE son propre bail — jeton de garde', async () => {
      // Une tâche qui dépasse son bail le voit repris par une autre instance ;
      // sa libération ne doit pas effacer celui de la seconde.
      const prisma = grantingPrisma();
      const service = new CronLockService(prisma);

      await service.runExclusively('un-job', 60, async () => 'fait');

      const [, posedJob, posedHolder] = prisma.$queryRaw.mock.calls[0];
      const [deleteSql, releasedJob, releasedHolder] =
        prisma.$executeRaw.mock.calls[0];
      expect(posedJob).toBe('un-job');
      expect(releasedJob).toBe('un-job');
      expect(releasedHolder).toBe(posedHolder);
      expect(deleteSql.join('?')).toContain('"holder" = ?');
    });

    it('un jeton différent à chaque exécution', async () => {
      const prisma = grantingPrisma();
      const service = new CronLockService(prisma);

      await service.runExclusively('un-job', 60, async () => 'fait');
      await service.runExclusively('un-job', 60, async () => 'fait');

      const [a, b] = prisma.$queryRaw.mock.calls.map((c: unknown[]) => c[2]);
      expect(a).not.toBe(b);
    });

    it('bail perdu avant la fin (0 ligne libérée) : la tâche aboutit, un avertissement est émis', async () => {
      const prisma = grantingPrisma();
      prisma.$executeRaw.mockResolvedValue(0);
      const service = new CronLockService(prisma);
      const warn = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);

      await expect(
        service.runExclusively('un-job', 60, async () => 'fait'),
      ).resolves.toBe('fait');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('perdu'));
    });

    it('libère le bail même quand la tâche échoue', async () => {
      const prisma = grantingPrisma();
      const service = new CronLockService(prisma);

      await expect(
        service.runExclusively('un-job', 60, async () => {
          throw new Error('boum');
        }),
      ).rejects.toThrow('boum');

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('une libération qui échoue ne masque pas le résultat de la tâche', async () => {
      const prisma = grantingPrisma();
      prisma.$executeRaw.mockRejectedValue(new Error('connexion perdue'));
      const service = new CronLockService(prisma);

      await expect(
        service.runExclusively('un-job', 60, async () => 'fait'),
      ).resolves.toBe('fait');
    });

    it('exécute quand même la tâche si le bail ne peut pas être lu', async () => {
      // L'absence d'expiration des commandes est pire qu'un doublon, qui
      // n'existe qu'à plusieurs instances.
      const prisma = grantingPrisma();
      prisma.$queryRaw.mockRejectedValue(new Error('relation absente'));
      const service = new CronLockService(prisma);
      const task = jest.fn().mockResolvedValue('fait');

      await expect(service.runExclusively('un-job', 60, task)).resolves.toBe(
        'fait',
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('exécute la tâche sans base injectée (tests, outils)', async () => {
      const service = new CronLockService(undefined);
      const task = jest.fn().mockResolvedValue('fait');

      await expect(service.runExclusively('un-job', 60, task)).resolves.toBe(
        'fait',
      );
    });
  });
});
