import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from '../firebase/firebase.service';

// Structure de message pour les événements SSE
export interface SseMessage {
  type: string;
  data: any;
}

/**
 * Canal Android d'un push (sonnerie vendeur, Phase 3 F3-01).
 *
 * Une commande payée à accepter part sur `new_orders_channel`, que l'app
 * vendeur crée avec un carillon dédié (`res/raw/new_order`) : c'est ce canal
 * qui sonne quand l'app est en arrière-plan. Une app antérieure, qui ne l'a
 * pas créé, retombe sur le canal par défaut d'Android.
 */
export function pushChannelFor(data?: Record<string, string>): {
  channelId: string;
  sound: string;
} {
  if (data?.type === 'new_order') {
    return { channelId: 'new_orders_channel', sound: 'new_order' };
  }
  return { channelId: 'high_importance_channel', sound: 'default' };
}

@Injectable()
export class NotificationsService {
  /** Plafond imposé par FCM sur `sendEachForMulticast`. */
  private static readonly FCM_BATCH_SIZE = 500;

  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private firebase: FirebaseService,
  ) {}

  // --- Logique pour les Push Notifications (FCM) ---

  async registerToken(
    firebaseUid: string,
    token: string,
  ): Promise<{ status: string }> {
    if (!firebaseUid) {
      throw new UnauthorizedException('Firebase UID not found');
    }
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      this.logger.warn(
        `Enregistrement token : user ${firebaseUid} introuvable`,
      );
      return { status: 'user_not_found' };
    }

    // M18 (audit du 28/08/2026) — comportement ASSUMÉ, documenté ici parce
    // qu'il surprend à la lecture : `update: { userId }` **transfère** un token
    // déjà connu vers le compte appelant.
    //
    // C'est voulu : sur un même téléphone, quand un utilisateur se déconnecte
    // et qu'un autre se connecte, le token FCM ne change pas — sans ce
    // transfert, le nouvel utilisateur ne recevrait rien et l'ancien
    // continuerait de recevoir les notifications sur un appareil qui n'est plus
    // le sien.
    //
    // Le risque résiduel : quelqu'un qui connaîtrait le token d'un tiers
    // pourrait le détourner — le priver de ses notifications et en pousser sur
    // son appareil. Il ne pourrait PAS lire celles d'autrui (l'envoi part du
    // `userId`, pas du token). L'entropie d'un token FCM le rend non
    // énumérable, et l'obtenir suppose déjà un accès à l'appareil.
    await this.prisma.fcmToken.upsert({
      where: { token },
      update: { userId: user.id },
      create: {
        token,
        userId: user.id,
        createdAt: new Date(),
      },
    });

    this.logger.log(`Registered FCM token pour l'utilisateur ${user.id}`);
    return { status: 'success' };
  }

  async removeToken(firebaseUid: string, token: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) return;

    await this.prisma.fcmToken.deleteMany({
      where: { token, userId: user.id },
    });
    this.logger.log(`FCM token supprimé — user: ${user.id}`);
  }

  /**
   * Diffuse une notification à une **audience**, en lots.
   *
   * ## Pourquoi cette méthode existe
   *
   * `MenusListener` bouclait sur tous les clients historiques d'un vendeur avec
   * un `await sendPushNotification(...)` par client : une requête `FcmToken`
   * **et** un aller-retour FCM chacun, en série, dans le processus web. Pour
   * mille clients, deux mille opérations bloquantes déclenchées par un simple
   * `POST /menus`.
   *
   * FCM accepte 500 jetons par appel (`sendEachForMulticast`). Les mêmes mille
   * clients coûtent désormais **une** requête de jetons et **deux** appels
   * réseau.
   *
   * ## Ce qu'elle ne fait pas
   *
   * Elle ne borne pas l'audience — c'est à l'appelant de décider combien de
   * personnes il a le droit de déranger, parce que la réponse dépend du geste
   * métier et pas du transport.
   */
  async sendPushToUsers(
    userIds: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ sent: number; failed: number; devices: number }> {
    const empty = { sent: 0, failed: 0, devices: 0 };
    if (userIds.length === 0) return empty;
    if (!this.firebase.isReady()) {
      this.logger.error('Firebase non prêt — diffusion annulée');
      return empty;
    }

    // UNE requête pour toute l'audience, au lieu d'une par destinataire.
    const rows = await this.prisma.fcmToken.findMany({
      where: { userId: { in: userIds } },
      select: { token: true },
    });
    if (rows.length === 0) {
      this.logger.warn(
        `Aucun FCM token pour les ${userIds.length} destinataire(s) visés`,
      );
      return empty;
    }

    const tokens = rows.map((r) => r.token);
    const stale: string[] = [];
    let sent = 0;
    let failed = 0;

    for (
      let i = 0;
      i < tokens.length;
      i += NotificationsService.FCM_BATCH_SIZE
    ) {
      const batch = tokens.slice(i, i + NotificationsService.FCM_BATCH_SIZE);
      const result = await this.firebase.getMessaging().sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        data: data ?? {},
        android: {
          priority: 'high',
          notification: {
            channelId: 'high_importance_channel',
            sound: 'default',
          },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', badge: 1 } },
        },
      });

      sent += result.successCount;
      failed += result.failureCount;

      // Même nettoyage que l'envoi unitaire : un jeton périmé qui reste en base
      // est un échec rejoué à chaque diffusion.
      result.responses.forEach((r, idx) => {
        const code = (r as { error?: { code?: string } }).error?.code;
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          stale.push(batch[idx]);
        }
      });
    }

    if (stale.length > 0) {
      await this.prisma.fcmToken.deleteMany({
        where: { token: { in: stale } },
      });
      this.logger.warn(`${stale.length} token(s) périmé(s) supprimé(s)`);
    }

    this.logger.log(
      `Diffusion : ${sent}/${tokens.length} appareil(s) — ${userIds.length} destinataire(s)`,
    );
    return { sent, failed, devices: tokens.length };
  }

  async sendPushNotification(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (!this.firebase.isReady()) {
      this.logger.error('Firebase non prêt — notification annulée');
      return;
    }

    const tokens = await this.prisma.fcmToken.findMany({
      where: { userId },
      select: { token: true },
    });

    if (tokens.length === 0) {
      this.logger.warn(`Aucun FCM token pour user ${userId}`);
      return;
    }

    // ✅ Envoi à TOUS les devices du user, pas seulement tokens[0]
    const results = await Promise.allSettled(
      tokens.map((t) =>
        this.firebase.getMessaging().send({
          token: t.token,
          notification: { title, body },
          data: data ?? {},
          android: {
            priority: 'high',
            notification: pushChannelFor(data),
          },
          apns: {
            headers: {
              'apns-priority': '10', // livraison immédiate (par défaut iOS = 5 = différé)
            },
            payload: {
              aps: { sound: 'default', badge: 1 },
            },
          },
        }),
      ),
    );

    // Nettoie les tokens invalides + loggue toute autre erreur FCM
    const tokensToDelete: string[] = [];
    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        const reason = result.reason as { code?: string; message?: string };
        const code = reason?.code;
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          tokensToDelete.push(tokens[idx].token);
        } else {
          // Erreur non liée à un token périmé (credentials, mauvais projet,
          // quota, API FCM désactivée…) — la loguer explicitement pour diagnostic.
          this.logger.error(
            `Échec envoi FCM — user ${userId}, code=${code ?? 'inconnu'} : ${reason?.message ?? String(reason)}`,
          );
        }
      }
    });

    if (tokensToDelete.length > 0) {
      await this.prisma.fcmToken.deleteMany({
        where: { token: { in: tokensToDelete } },
      });
      this.logger.warn(
        `${tokensToDelete.length} token(s) invalide(s) supprimé(s) pour user ${userId}`,
      );
    }

    const success = results.filter((r) => r.status === 'fulfilled').length;
    this.logger.log(
      `Notification envoyée : ${success}/${tokens.length} devices — user ${userId}`,
    );
  }
}
