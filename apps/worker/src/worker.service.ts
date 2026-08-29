import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { shouldRunBackgroundJobs } from '../../lilia-app/src/config/background-jobs';

/**
 * Le worker n'a pas de logique propre : il héberge les services planifiés
 * importés depuis `apps/lilia-app`. Ce service ne sert qu'à rendre son état
 * lisible — au démarrage dans les logs, et via `/health` pour l'orchestrateur.
 */
@Injectable()
export class WorkerService implements OnModuleInit {
  private readonly logger = new Logger(WorkerService.name);
  private readonly startedAt = new Date();

  onModuleInit(): void {
    if (shouldRunBackgroundJobs()) {
      this.logger.log(
        '⚙️  Worker démarré — crons et dépilage outbox actifs sur ce processus.',
      );
    } else {
      // Cas d'une erreur de configuration : un worker avec le flag à false ne
      // fait littéralement rien. Mieux vaut le dire fort.
      this.logger.error(
        '⚠️  RUN_BACKGROUND_JOBS=false sur le WORKER : aucune tâche de fond ' +
          'ne sera exécutée par ce processus. Vérifiez la configuration.',
      );
    }
  }

  health(): {
    status: string;
    role: string;
    backgroundJobs: boolean;
    startedAt: string;
    uptimeSeconds: number;
  } {
    return {
      status: 'ok',
      role: 'worker',
      backgroundJobs: shouldRunBackgroundJobs(),
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
    };
  }
}
