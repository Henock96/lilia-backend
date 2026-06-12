/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { SmsService } from '../sms/sms.service';
import { UserCreatedEvent, UserPhoneCompletedEvent } from '../events/user-events';

/** Fenetre apres inscription pendant laquelle un SMS de bienvenue peut encore partir (cas Google). */
const WELCOME_SMS_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class UserListener {
  private readonly logger = new Logger(UserListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
  ) {}

  /** Bienvenue à la création du compte : email (toujours) + SMS (si numéro présent). */
  @OnEvent('user.created')
  async handleUserCreated(event: UserCreatedEvent): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: event.userId },
        select: {
          email: true, nom: true, phone: true,
          welcomeEmailSentAt: true, welcomeSmsSentAt: true,
        },
      });
      if (!user) return;

      if (user.email && !user.welcomeEmailSentAt && this.emailService.isReady()) {
        const ok = await this.emailService.sendWelcomeEmail(
          user.email,
          user.nom || user.email.split('@')[0],
        );
        if (ok) {
          await this.prisma.user.update({
            where: { id: event.userId },
            data: { welcomeEmailSentAt: new Date() },
          });
        }
      }

      if (user.phone && !user.welcomeSmsSentAt) {
        const ok = await this.smsService.sendWelcome(user.phone, user.nom || 'client');
        if (ok) {
          await this.prisma.user.update({
            where: { id: event.userId },
            data: { welcomeSmsSentAt: new Date() },
          });
        }
      }
    } catch (error) {
      this.logger.error(
        `Erreur bienvenue (user.created) ${event.userId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  /** Numéro complété après coup (cas Google) : SMS de bienvenue si compte récent. */
  @OnEvent('user.phone.completed')
  async handlePhoneCompleted(event: UserPhoneCompletedEvent): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: event.userId },
        select: { nom: true, phone: true, welcomeSmsSentAt: true, createdAt: true },
      });
      if (!user || !user.phone || user.welcomeSmsSentAt) return;

      const oneDayAgo = new Date(Date.now() - WELCOME_SMS_WINDOW_MS);
      if (user.createdAt < oneDayAgo) return;

      const ok = await this.smsService.sendWelcome(user.phone, user.nom || 'client');
      if (ok) {
        await this.prisma.user.update({
          where: { id: event.userId },
          data: { welcomeSmsSentAt: new Date() },
        });
      }
    } catch (error) {
      this.logger.error(
        `Erreur bienvenue (user.phone.completed) ${event.userId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
