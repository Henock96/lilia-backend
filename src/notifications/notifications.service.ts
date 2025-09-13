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

// Structure de message pour les événements SSE
export interface SseMessage {
  type: string;
  data: any;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly clients = new Map<string, Subject<SseMessage>>();

  constructor(private prisma: PrismaService) {}

  // --- Logique pour les Server-Sent Events (SSE) ---

  /**
   * Ajoute un client à la liste d'écoute SSE.
   * Le Subject est un observable qui peut être utilisé pour envoyer des messages.
   */
  addSseClient(userId: string): Subject<SseMessage> {
    const subject = new Subject<SseMessage>();
    this.clients.set(userId, subject);
    this.logger.log(`SSE client connected for user: ${userId}`);
    return subject;
  }

  /**
   * Supprime un client de la liste d'écoute SSE.
   */
  removeSseClient(userId: string) {
    if (this.clients.has(userId)) {
      this.clients.get(userId).complete(); // Termine l'observable
      this.clients.delete(userId);
      this.logger.log(`SSE client disconnected for user: ${userId}`);
    }
  }

  /**
   * Envoie un événement SSE à un utilisateur spécifique.
   */
  sendEventToUser(userId: string, event: SseMessage) {
    if (this.clients.has(userId)) {
      this.clients.get(userId).next(event);
      this.logger.log(`Sent SSE event '${event.type}' to user: ${userId}`);
    } else {
      this.logger.log(
        `No active SSE client for user ${userId}. Skipping event '${event.type}'.`,
      );
    }
  }

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

    this.logger.log(`Registered FCM token for user ${user.id}`);
    return { status: 'success' };
  }

  async sendPushNotification(
    userId: string,
    title: string,
    body: string,
    data?: { [key: string]: string },
  ) {
    console.log('🔵 Sending notification to userId:', userId);
    console.log('🔵 Title:', title);
    console.log('🔵 Body:', body);

    const userTokens = await this.prisma.fcmToken.findMany({
      where: { userId },
      select: { token: true },
    });

    if (userTokens.length === 0) {
      this.logger.log(
        `No FCM tokens found for user ${userId}. Skipping notification.`,
      );
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

    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      this.logger.log(
        `Successfully sent notification to ${response.successCount} devices.`,
      );

      if (response.failureCount > 0) {
        await this.handleInvalidTokens(response, tokens);
      }
    } catch (error) {
      this.logger.error('Error sending push notification:', error);
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
          this.logger.error(`Failed to send to token ${tokens[index]}`, error);
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
