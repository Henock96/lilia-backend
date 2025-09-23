import {
  Body,
  Injectable,
  Logger,
  Request,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as admin from 'firebase-admin';
import { Subject } from 'rxjs';
import { FirebaseService } from 'src/firebase/firebase.service';

// Structure de message pour les événements SSE
export interface SseMessage {
  type: string;
  data: any;
}
interface NotificationData {
  [key: string]: string;
}

interface NotificationResult {
  successCount: number;
  failureCount: number;
  responses: admin.messaging.SendResponse[];
}
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly clients = new Map<string, Subject<SseMessage>>();

  constructor(
    private prisma: PrismaService,
    private firebaseService: FirebaseService,
  ) {}

  // --- Logique pour les Push Notifications (FCM) ---

  async registerToken(
    @Request() req,
    @Body('token') token: string,
  ): Promise<{ status: string }> {
    const firebaseUid = req.user?.uid;

    if (!firebaseUid) {
      throw new UnauthorizedException('Firebase UID not found');
    }
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      this.logger.warn(`User with firebaseUid ${firebaseUid} not found.`);
      return { status: 'user_not_found' };
    }

    await this.prisma.fcmToken.upsert({
      where: { token },
      update: { userId: user.id },
      create: { token, userId: user.id },
    });

    this.logger.log(`Registered FCM token pour l'utilisateur ${user.id}`);
    return { status: 'success' };
  }

  async sendPushNotification(
    userId: string,
    title: string,
    body: string,
    data?: NotificationData,
  ): Promise<NotificationResult | null> {
    // Vérifier que Firebase est prêt
    if (!this.firebaseService.isReady()) {
      this.logger.error('Firebase not ready, cannot send notification', {
        userId,
        title,
        error: this.firebaseService.getInitializationError()?.message,
      });
      return;
    }
    console.log('🔵 Envoi de notification à:', userId);
    console.log('🔵 Title:', title);
    console.log('🔵 Body:', body);

    const userTokens = await this.prisma.fcmToken.findMany({
      where: { userId },
      select: { token: true },
    });
    console.log('🔵 Found tokens count:', userTokens.length);
    if (userTokens.length === 0) {
      this.logger.log(
        `No FCM tokens found for user ${userId}. Skipping notification.`,
      );
      // Debug supplémentaire : vérifier si le userId existe
      const userExists = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, firebaseUid: true },
      });
      console.log('🔍 User exists check:', userExists);
      return;
    }

    console.log('🔵 Found tokens:', userTokens.length);
    userTokens.forEach((t, i) => {
      console.log(`🔵 Token ${i + 1}:`, t.token.substring(0, 20) + '...');
    });
    const tokens = userTokens.map((t) => t.token);

    const message: admin.messaging.MulticastMessage = {
      tokens,
      notification: { title, body },
      data: data || {},
      android: {
        priority: 'high',
        notification: {
          channelId: 'default', // Important pour Android 8+
          priority: 'high',
        },
      },
      apns: {
        payload: {
          aps: {
            contentAvailable: true,
            sound: 'default',
          },
        },
      },
    };
    console.log('🔵 FCM Message preparé:', {
      tokenCount: tokens.length,
      notification: message.notification,
      data: message.data,
    });

    try {
      console.log(
        '🔵 Appel de Firebase admin.messaging().sendEachForMulticast...',
      );
      const response = await admin.messaging().sendEachForMulticast(message);
      this.logger.log(
        `Notification envoyée avec succès aux appareils ${response.successCount}.`,
      );

      if (response.failureCount > 0) {
        response.responses.forEach((resp, idx) => {
          if (!resp.success && resp.error) {
            this.logger.error(
              `Echec pour envoyer le token ${tokens[idx]}:${resp.error.code} - ${resp.error.message}`,
            );
          }
        });
        await this.handleInvalidTokens(response, tokens);
      }
      return response;
    } catch (error) {
      this.logger.error(
        `Erreur pour envoyer la notification ${userId}:`,
        error,
      );
    }
  }

  private async handleInvalidTokens(
    response: admin.messaging.BatchResponse,
    tokens: string[],
  ) {
    const tokensToDelete: string[] = [];
    response.responses.forEach((result, index) => {
      if (!result.success) {
        const error = result.error;
        if (
          error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered'
        ) {
          const invalidToken = tokens[index];
          tokensToDelete.push(invalidToken);
          this.logger.log(
            `Marking invalid token for deletion: ${invalidToken}`,
          );
        } else {
          this.logger.error(
            `Erreur token: Échec de l'envoi au token ${tokens[index]}`,
            error,
          );
        }
      }
    });

    if (tokensToDelete.length > 0) {
      await this.prisma.fcmToken.deleteMany({
        where: {
          token: { in: tokensToDelete },
        },
      });
      this.logger.log(
        `Deleted ${tokensToDelete.length} invalid tokens from the database.`,
      );
    }
  }
}
