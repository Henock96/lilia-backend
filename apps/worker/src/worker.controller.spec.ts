import { Test, TestingModule } from '@nestjs/testing';
import { WorkerController } from './worker.controller';
import { WorkerService } from './worker.service';

/**
 * Le worker n'expose que sa santé. Ce qu'on vérifie ici, c'est qu'il dit la
 * vérité sur son rôle : un worker démarré avec `RUN_BACKGROUND_JOBS=false` ne
 * ferait rien du tout, et c'est le genre d'erreur de configuration qu'on veut
 * voir dans une sonde plutôt que de découvrir par des commandes non expirées.
 */
describe('WorkerController', () => {
  let controller: WorkerController;
  const originalFlag = process.env.RUN_BACKGROUND_JOBS;

  async function build(): Promise<WorkerController> {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorkerController],
      providers: [WorkerService],
    }).compile();
    return module.get<WorkerController>(WorkerController);
  }

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.RUN_BACKGROUND_JOBS;
    } else {
      process.env.RUN_BACKGROUND_JOBS = originalFlag;
    }
  });

  it('signale un worker opérationnel', async () => {
    delete process.env.RUN_BACKGROUND_JOBS; // défaut = tâches actives
    controller = await build();

    const health = controller.health();
    expect(health.status).toBe('ok');
    expect(health.role).toBe('worker');
    expect(health.backgroundJobs).toBe(true);
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('signale un worker mal configuré (aucune tâche de fond)', async () => {
    process.env.RUN_BACKGROUND_JOBS = 'false';
    controller = await build();

    expect(controller.health().backgroundJobs).toBe(false);
  });

  it('la racine répond comme /health (sonde Render)', async () => {
    controller = await build();
    expect(controller.root()).toEqual(controller.health());
  });
});
