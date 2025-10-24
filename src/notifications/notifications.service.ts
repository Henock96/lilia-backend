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
    this.logger.log(`🔔 Attempting to send notification to user: ${userId}`);
    this.logger.log(`📝 Title: ${title}`);
    this.logger.log(`📝 Body: ${body}`);
    this.logger.log(`📦 Data: ${JSON.stringify(data)}`);

    // Vérifier que Firebase est prêt
    if (!this.firebaseService.isReady()) {
      this.logger.error('❌ Firebase not ready, cannot send notification', {
        userId,
        title,
        error: this.firebaseService.getInitializationError()?.message,
      });
      return null;
    }

    // Récupérer les tokens FCM de l'utilisateur
    const userTokens = await this.prisma.fcmToken.findMany({
      where: { userId },
      select: { token: true, createdAt: true },
    });

    this.logger.log(`📱 Found ${userTokens.length} FCM token(s) for user ${userId}`);

    if (userTokens.length === 0) {
      this.logger.warn(`⚠️ No FCM tokens found for user ${userId}. Skipping notification.`);

      // Debug : vérifier si le userId existe
      const userExists = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, firebaseUid: true, nom: true },
      });

      if (userExists) {
        this.logger.log(`ℹ️ User exists: ${userExists.email} (${userExists.nom}), but has no FCM token registered`);
      } else {
        this.logger.error(`❌ User ${userId} not found in database`);
      }

      return null;
    }

    // Log des tokens (premiers caractères seulement pour sécurité)
    userTokens.forEach((t, i) => {
      this.logger.log(`Token ${i + 1}: ${t.token.substring(0, 30)}... (created: ${t.createdAt})`);
    });

    // Préparer le message
    const message: admin.messaging.Message = {
      token: userTokens[0].token, // Envoyer au premier token (normalement il n'y en a qu'un)
      notification: {
        title,
        body
      },
      data: data || {},
      android: {
        priority: 'high',
        notification: {
          channelId: 'high_importance_channel',
          priority: 'high',
          sound: 'default',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            contentAvailable: true,
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    try {
      this.logger.log('📤 Sending notification via Firebase Admin SDK...');
      const response = await admin.messaging().send(message);
      this.logger.log(`✅ Notification sent successfully! Message ID: ${response}`);
      return response;
    } catch (error) {
      this.logger.error(`❌ Failed to send notification to user ${userId}:`, {
        error: error.message,
        code: error.code,
        details: error.details,
      });

      // Si le token est invalide, le supprimer
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        this.logger.warn(`🗑️ Removing invalid token for user ${userId}`);
        await this.prisma.fcmToken.delete({
          where: { token: userTokens[0].token },
        });
      }

      return null;
    }
  }
}
