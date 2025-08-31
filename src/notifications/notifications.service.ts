import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as admin from 'firebase-admin';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private prisma: PrismaService) {}

  async registerToken(firebaseUid: string, token: string): Promise<{ status: string }> {
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
    const userTokens = await this.prisma.fcmToken.findMany({
      where: { userId },
      select: { token: true },
    });

    if (userTokens.length === 0) {
      this.logger.log(`No FCM tokens found for user ${userId}. Skipping notification.`);
      return;
    }

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
      const response = await admin.messaging().sendMulticast(message);
      this.logger.log(`Successfully sent notification to ${response.successCount} devices.`);
      
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
          this.logger.log(`Marking invalid token for deletion: ${invalidToken}`);
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
      this.logger.log(`Deleted ${tokensToDelete.length} invalid tokens from the database.`);
    }
  }
}