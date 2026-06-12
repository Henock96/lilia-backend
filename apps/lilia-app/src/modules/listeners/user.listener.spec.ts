import { UserListener } from './user.listener';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { SmsService } from '../sms/sms.service';
import { UserCreatedEvent, UserPhoneCompletedEvent } from '../events/user-events';

describe('UserListener', () => {
  let listener: UserListener;
  let prisma: any;
  let email: any;
  let sms: any;

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) } };
    email = { isReady: jest.fn().mockReturnValue(true), sendWelcomeEmail: jest.fn().mockResolvedValue(true) };
    sms = { sendWelcome: jest.fn().mockResolvedValue(true) };
    listener = new UserListener(prisma as PrismaService, email as EmailService, sms as SmsService);
  });

  describe('user.created', () => {
    it('envoie email + SMS et pose les deux flags quand email et phone sont présents', async () => {
      prisma.user.findUnique.mockResolvedValue({
        email: 'jean@example.com', nom: 'Jean', phone: '061234567',
        welcomeEmailSentAt: null, welcomeSmsSentAt: null,
      });
      await listener.handleUserCreated(new UserCreatedEvent('u1', 'Jean', new Date()));
      expect(email.sendWelcomeEmail).toHaveBeenCalledWith('jean@example.com', 'Jean');
      expect(sms.sendWelcome).toHaveBeenCalledWith('061234567', 'Jean');
      expect(prisma.user.update).toHaveBeenCalledTimes(2);
    });

    it('envoie seulement l\'email quand il n\'y a pas de numéro (cas Google)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        email: 'g@example.com', nom: 'Gina', phone: '',
        welcomeEmailSentAt: null, welcomeSmsSentAt: null,
      });
      await listener.handleUserCreated(new UserCreatedEvent('u2', 'Gina', new Date()));
      expect(email.sendWelcomeEmail).toHaveBeenCalledTimes(1);
      expect(sms.sendWelcome).not.toHaveBeenCalled();
    });

    it('idempotence : n\'envoie pas si les flags sont déjà posés', async () => {
      prisma.user.findUnique.mockResolvedValue({
        email: 'a@b.com', nom: 'A', phone: '061111111',
        welcomeEmailSentAt: new Date(), welcomeSmsSentAt: new Date(),
      });
      await listener.handleUserCreated(new UserCreatedEvent('u3', 'A', new Date()));
      expect(email.sendWelcomeEmail).not.toHaveBeenCalled();
      expect(sms.sendWelcome).not.toHaveBeenCalled();
    });

    it('n\'envoie pas l\'email si emailService.isReady() est false mais envoie le SMS', async () => {
      email.isReady.mockReturnValue(false);
      prisma.user.findUnique.mockResolvedValue({
        email: 'a@b.com', nom: 'A', phone: '061234567',
        welcomeEmailSentAt: null, welcomeSmsSentAt: null,
      });
      await listener.handleUserCreated(new UserCreatedEvent('u1', 'A', new Date()));
      expect(email.sendWelcomeEmail).not.toHaveBeenCalled();
      expect(sms.sendWelcome).toHaveBeenCalledTimes(1);
    });

    it('ne pose pas le flag SMS quand l\'envoi echoue (sendWelcome renvoie false)', async () => {
      sms.sendWelcome.mockResolvedValue(false);
      prisma.user.findUnique.mockResolvedValue({
        email: 'a@b.com', nom: 'A', phone: '061234567',
        welcomeEmailSentAt: new Date(), welcomeSmsSentAt: null,
      });
      await listener.handleUserCreated(new UserCreatedEvent('u1', 'A', new Date()));
      expect(sms.sendWelcome).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('user.phone.completed', () => {
    it('envoie le SMS si numéro présent, flag absent, compte récent', async () => {
      prisma.user.findUnique.mockResolvedValue({
        nom: 'Gina', phone: '061234567', welcomeSmsSentAt: null, createdAt: new Date(),
      });
      await listener.handlePhoneCompleted(new UserPhoneCompletedEvent('u2'));
      expect(sms.sendWelcome).toHaveBeenCalledWith('061234567', 'Gina');
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('n\'envoie pas si le compte est ancien (> 24h)', async () => {
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      prisma.user.findUnique.mockResolvedValue({
        nom: 'Vieux', phone: '061234567', welcomeSmsSentAt: null, createdAt: old,
      });
      await listener.handlePhoneCompleted(new UserPhoneCompletedEvent('u4'));
      expect(sms.sendWelcome).not.toHaveBeenCalled();
    });

    it('n\'envoie pas si le SMS de bienvenue est déjà parti', async () => {
      prisma.user.findUnique.mockResolvedValue({
        nom: 'X', phone: '061234567', welcomeSmsSentAt: new Date(), createdAt: new Date(),
      });
      await listener.handlePhoneCompleted(new UserPhoneCompletedEvent('u5'));
      expect(sms.sendWelcome).not.toHaveBeenCalled();
    });
  });
});
