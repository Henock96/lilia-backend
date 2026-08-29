import { Controller, Get } from '@nestjs/common';
import { WorkerService } from './worker.service';

/**
 * Seul endpoint du worker : sa santé.
 *
 * Aucune route métier ici — le worker ne sert pas de trafic. Render exige
 * toutefois qu'un service web réponde sur un port, et un orchestrateur a
 * besoin de savoir si le processus est vivant.
 */
@Controller()
export class WorkerController {
  constructor(private readonly workerService: WorkerService) {}

  @Get()
  root() {
    return this.workerService.health();
  }

  @Get('health')
  health() {
    return this.workerService.health();
  }
}
