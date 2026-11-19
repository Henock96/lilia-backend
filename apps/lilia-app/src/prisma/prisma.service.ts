import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { buildPoolConfig } from './pool-config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const adapter = new PrismaPg(buildPoolConfig(config));
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connecté à PostgreSQL via Prisma');
  }

  /**
   * Ferme le pool à l'arrêt (`app.close()`, `enableShutdownHooks` sur
   * SIGTERM). Sans lui, ses connexions restaient ouvertes : 6 mesurées le
   * 19/11 après un arrêt, et un processus de test qui ne rendait pas la main.
   */
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
