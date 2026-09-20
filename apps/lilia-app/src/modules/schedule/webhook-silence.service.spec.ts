import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { WebhookSilenceService } from './webhook-silence.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CronLockService } from '../../common/locks/cron-lock.service';

/**
 * **Quand le silence du webhook doit faire du bruit — et quand il ne doit pas.**
 *
 * La difficulté de cette surveillance n'est pas de détecter l'absence : c'est
 * de ne pas crier pour rien. Une alerte qui se déclenche chaque nuit faute de
 * commandes apprend à l'exploitant à l'ignorer, et le jour où elle a raison,
 * elle n'est plus lue. La condition porte donc sur « de l'activité **sans**
 * callback », jamais sur « pas de callback ».
 */
describe('WebhookSilenceService', () => {
  let service: WebhookSilenceService;

  const prisma = {
    paymentEvent: { count: jest.fn() },
    incident: {
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const config = { get: jest.fn() };

  /** Le verrou n'est pas le sujet : on exécute le corps directement. */
  const cronLock = {
    runExclusively: jest.fn((_n: string, _t: number, fn: () => Promise<void>) =>
      fn(),
    ),
  };

  /**
   * Répond en lisant le `where` réellement passé, plutôt qu'en empilant des
   * `mockResolvedValueOnce`.
   *
   * La file de valeurs « une fois » n'est **pas** vidée par `clearAllMocks`
   * (il faudrait `resetAllMocks`) : un test qui en consomme moins qu'il n'en
   * pose contamine le suivant, et l'assertion échoue dans un cas qui n'est pas
   * celui qu'on lit. Répondre à la question posée supprime le problème au lieu
   * de le contourner — et rend le test lisible : chaque nombre est nommé.
   */
  const seedCounts = (activity: number, webhooks: number, allTime = 0) => {
    prisma.paymentEvent.count.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) => {
        if (where.source === 'WEBHOOK') {
          return Promise.resolve(where.receivedAt ? webhooks : allTime);
        }
        return Promise.resolve(activity);
      },
    );
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    config.get.mockReturnValue('PAWAPAY');
    prisma.incident.findFirst.mockResolvedValue(null);
    prisma.incident.create.mockResolvedValue({ id: 'i1' });
    prisma.incident.updateMany.mockResolvedValue({ count: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookSilenceService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: CronLockService, useValue: cronLock },
      ],
    }).compile();

    service = module.get(WebhookSilenceService);
  });

  it('ouvre un incident quand il y a eu de l’activité et aucun callback', async () => {
    seedCounts(31, 0, 0);

    await service.check();

    expect(prisma.incident.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.incident.create.mock.calls[0][0];
    expect(data.severity).toBe('HIGH');
    // Le message doit porter le chemin du diagnostic : une alerte qui dit
    // « quelque chose ne va pas » sans dire où regarder coûte une enquête.
    expect(data.description).toContain('/admin/payments/webhook-health');
  });

  it('ne dit RIEN sans activité — un dimanche creux n’est pas une panne', async () => {
    seedCounts(0, 0);

    await service.check();

    expect(prisma.incident.create).not.toHaveBeenCalled();
  });

  it('ne dit rien quand des callbacks arrivent', async () => {
    seedCounts(12, 12);

    await service.check();

    expect(prisma.incident.create).not.toHaveBeenCalled();
  });

  it('clôt l’incident ouvert dès que les callbacks reviennent', async () => {
    seedCounts(12, 3);

    await service.check();

    expect(prisma.incident.updateMany).toHaveBeenCalledTimes(1);
    const { data } = prisma.incident.updateMany.mock.calls[0][0];
    expect(data.status).toBe('RESOLVED');
  });

  it('n’ouvre pas un second incident tant que le premier est ouvert', async () => {
    seedCounts(31, 0, 0);
    prisma.incident.findFirst.mockResolvedValue({ id: 'déjà-ouvert' });

    await service.check();

    // Sans cette garde, le cron en créerait un toutes les six heures et la
    // file d'incidents deviendrait illisible.
    expect(prisma.incident.create).not.toHaveBeenCalled();
  });

  it('ne surveille rien en mode MANUAL — aucun prestataire n’émet de callback', async () => {
    config.get.mockReturnValue('MANUAL');

    await service.check();

    expect(prisma.paymentEvent.count).not.toHaveBeenCalled();
    expect(prisma.incident.create).not.toHaveBeenCalled();
  });

  it('ne fait pas tomber le processus si l’ouverture de l’incident échoue', async () => {
    seedCounts(31, 0, 0);
    prisma.incident.create.mockRejectedValue(new Error('base indisponible'));

    // Une surveillance qui tue le processus qu'elle surveille est pire que pas
    // de surveillance.
    await expect(service.check()).resolves.toBeUndefined();
  });
});
