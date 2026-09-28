import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OutboxEvent, StatusUser } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from '../firebase/firebase.service';
import { UserCacheService } from '../auth/services/user-cache.service';
import { OutboxService } from './outbox.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { USER_BAN_APPLIED_EVENT } from './outbox-events';

/**
 * F3-12.1 R7 — coupure d'un compte dont le ban différé vient de s'appliquer.
 *
 * Le ban lui-même est déjà écrit (`BLOCKED`, `OFFLINE`) par la transaction qui
 * a clos la dernière course du livreur ; la base refuse donc déjà tout geste
 * sensible. Il reste ce qu'une transaction ne sait pas faire : désactiver le
 * compte Firebase, révoquer ses jetons, purger le cache de session. Sans quoi
 * le banni garderait l'accès aux routes non sensibles jusqu'à 5 min, et se
 * reconnecterait ensuite avec un jeton frais.
 *
 * Idempotent, et relu en base : si le compte a été débanni entre-temps, on
 * ne coupe rien — couper un compte réactivé serait le pire des deux ordres.
 */
@Injectable()
export class AccountOutboxEffectsService implements OnModuleInit {
  private readonly logger = new Logger(AccountOutboxEffectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcherService,
    private readonly firebase: FirebaseService,
    private readonly userCache: UserCacheService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerHandler(USER_BAN_APPLIED_EVENT, (e) =>
      this.dispatchBanApplied(e),
    );
  }

  async dispatchBanApplied(event: OutboxEvent): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: event.aggregateId },
      select: { firebaseUid: true, statusUser: true },
    });
    if (!user) {
      await this.outbox.markFailed(event.id, 'Utilisateur introuvable');
      return;
    }
    if (user.statusUser !== StatusUser.BLOCKED) {
      this.logger.warn(
        `Ban appliqué puis levé pour ${event.aggregateId} : compte Firebase laissé actif.`,
      );
      await this.outbox.markSent(event.id);
      return;
    }

    // Une erreur remonte au dispatcher, qui rejoue avec backoff.
    await this.firebase.setUserDisabled(user.firebaseUid, true);
    await this.firebase.revokeUserTokens(user.firebaseUid);
    await this.userCache.invalidateOrThrow(user.firebaseUid);

    this.logger.warn(`Ban différé exécuté pour ${event.aggregateId}`);
    await this.outbox.markSent(event.id);
  }
}
