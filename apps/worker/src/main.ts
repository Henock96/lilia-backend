import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';

import { WorkerModule } from './worker.module';

/**
 * Processus des tâches de fond : crons + dépilage de la boîte d'envoi.
 *
 * Démarrage : `npm run start:worker` (ou `node dist/apps/worker/main`).
 * À déployer comme un service Render distinct, avec le service web configuré
 * en `RUN_BACKGROUND_JOBS=false`.
 */
async function bootstrap() {
  const logger = new Logger('WorkerBootstrap');
  const app = await NestFactory.create(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  // Sans cet appel, `onModuleDestroy` n'est jamais exécuté sur SIGTERM : les
  // connexions Redis resteraient ouvertes à chaque redéploiement. Même
  // correctif que côté web.
  app.enableShutdownHooks();

  // Port distinct de l'app web pour permettre de lancer les deux en local.
  const port = parseInt(process.env.WORKER_PORT ?? '8081', 10);
  await app.listen(port, '0.0.0.0');
  logger.log(`Worker à l'écoute sur le port ${port}`);
}

bootstrap().catch((error) => {
  console.error('Erreur fatale au démarrage du worker :', error);
  process.exit(1);
});
