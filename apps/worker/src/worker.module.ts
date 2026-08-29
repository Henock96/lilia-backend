import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { RedisModule } from '@nestjs-modules/ioredis';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaModule } from '../../lilia-app/src/prisma/prisma.module';
import { FirebaseModule } from '../../lilia-app/src/modules/firebase/firebase.module';
import { NotificationsCoreModule } from '../../lilia-app/src/modules/notifications/notifications-core.module';
import { SmsModule } from '../../lilia-app/src/modules/sms/sms.module';
import { OutboxModule } from '../../lilia-app/src/modules/outbox/outbox.module';
import { AppScheduleModule } from '../../lilia-app/src/modules/schedule/schedule.module';
import { LoyaltyModule } from '../../lilia-app/src/modules/loyalty/loyalty.module';
import { envValidationSchema } from '../../lilia-app/src/config/env.validation';

import { WorkerController } from './worker.controller';
import { WorkerService } from './worker.service';

/**
 * Processus de tâches de fond.
 *
 * Jusqu'ici, les 5 crons et le dépilage de l'outbox tournaient dans le
 * processus web, sur la même event loop que les requêtes HTTP. À l'heure de
 * pointe, un lot de notifications entrait en concurrence avec les checkouts.
 *
 * Ce module importe **uniquement** ce dont les tâches de fond ont besoin :
 * pas de contrôleurs métier, pas de guards d'authentification, pas de
 * WebSocket. Il n'expose qu'un endpoint de santé, pour que l'orchestrateur
 * sache que le processus est vivant.
 *
 * ⚠️ Les imports pointent vers `apps/lilia-app` : les deux applications
 * partagent le même code métier. C'est assumé — dupliquer `OutboxService` ou
 * `OrderLifecycleService` pour le worker créerait deux implémentations à
 * maintenir en parallèle, et c'est exactement le genre de divergence qui
 * produit des bugs invisibles.
 *
 * Déploiement : ce processus doit tourner avec `RUN_BACKGROUND_JOBS=true`
 * (défaut) et le service web avec `RUN_BACKGROUND_JOBS=false`. Tant que le
 * worker n'est pas déployé, laisser le web à `true` : les verrous Redis
 * empêchent de toute façon un double traitement.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level:
          process.env.LOG_LEVEL ??
          (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    // Les verrous de cron et l'idempotence passent par Redis : sans lui, deux
    // processus feraient le même travail.
    RedisModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        type: 'single',
        url: config.get('REDIS_URL'),
      }),
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    // `@OnEvent` n'a pas de portée inter-processus : les événements émis par
    // le web n'arrivent pas ici. Le module est présent parce que les services
    // partagés en dépendent, pas pour recevoir quoi que ce soit.
    EventEmitterModule.forRoot({ maxListeners: 20, ignoreErrors: false }),

    PrismaModule,
    FirebaseModule,
    NotificationsCoreModule,
    SmsModule,
    LoyaltyModule,
    OutboxModule, // dépilage + escalade SMS
    AppScheduleModule, // expiration, horaires, stock, rappels
  ],
  controllers: [WorkerController],
  providers: [WorkerService],
})
export class WorkerModule {}
