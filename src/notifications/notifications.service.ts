import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
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
      this.logger.warn(`User with firebaseUid ${firebaseUid} not found.`);
      return { status: 'user_not_found' };
    }

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

  async sendPushNotification(
    userId: string,
    title: string,
    body: string,
    data?: NotificationData,
  ): Promise<string | null> {
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

    const message: admin.messaging.Message = {
      token: tokens[0],
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

    try {
      console.log(
        '🔵 Appel de Firebase admin.messaging().sendEachForMulticast...',
      );
      const response = await admin.messaging().send(message);
      this.logger.log(
        `Notification envoyée avec succès aux appareils ${response.toString}.`,
      );
      return response;
    } catch (error) {
      this.logger.error(
        `Erreur pour envoyer la notification ${userId}:`,
        error,
      );
    }
  }
}
