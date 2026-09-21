// ⚠️ DOIT rester le tout premier import — initialise Sentry avant que les
// autres modules ne soient chargés (auto-instrumentation de http, pg, etc.).
//
// Il manquait ici jusqu'au 21/09/2026, alors qu'il était bien présent côté web.
// Ce processus exécute les neuf crons — réconciliation des paiements,
// expiration des commandes, détection du silence des webhooks, alerte
// « reversement au statut inconnu » — dont les alertes passent toutes par
// `Sentry.captureMessage`. Sans initialisation, ces appels sont des **no-ops** :
// le jour où le worker est déployé et le web passé à `RUN_BACKGROUND_JOBS=false`,
// tout l'alerting financier de fond s'éteint, sans que rien ne le signale.
//
// Le module est partagé avec `apps/lilia-app`, comme le reste du code métier :
// deux copies d'une configuration Sentry finiraient par diverger.
import '../../lilia-app/src/instrument';

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
