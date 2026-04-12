// sms/sms.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly isEnabled: boolean;
  private readonly sender: string;
  private client: any;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('AFRICAS_TALKING_API_KEY');
    const username = this.config.get<string>('AFRICAS_TALKING_USERNAME');
    this.sender = this.config.get<string>('SMS_SENDER_ID', 'LiliaFood');
    this.isEnabled = !!(apiKey && username);

    if (this.isEnabled) {
      // Import dynamique pour ne pas bloquer si non installé
      const AfricasTalking = require('africastalking');
      const at = AfricasTalking({ apiKey, username });
      this.client = at.SMS;
      this.logger.log('SMS service initialisé (Africa\'s Talking)');
    } else {
      this.logger.warn('SMS service désactivé — AFRICAS_TALKING_API_KEY manquant');
    }
  }

  /**
   * Envoie un SMS.
   * En mode dev/sans clé : log uniquement, pas d'erreur.
   */
  async send(to: string, message: string): Promise<boolean> {
    if (!this.isEnabled) {
      this.logger.debug(`[SMS simulé] → ${to} : ${message}`);
      return true;
    }

    try {
      const formatted = this.formatNumber(to);
      await this.client.send({
        to: [formatted],
        message,
        from: this.sender,
      });
      this.logger.log(`SMS envoyé → ${formatted}`);
      return true;
    } catch (error) {
      this.logger.error(`Échec SMS → ${to}: ${error.message}`);
      return false;
    }
  }

  /** Confirmation commande pour les clients sans smartphone */
  async sendOrderConfirmation(phone: string, orderId: string, total: number): Promise<boolean> {
    const ref = orderId.slice(-6).toUpperCase();
    return this.send(
      phone,
      `Lilia Food : Commande #${ref} confirmée. Total : ${total} FCFA. Merci !`,
    );
  }

  /** Alerte livreur assigné */
  async sendDeliveryAssigned(phone: string, restaurantName: string): Promise<boolean> {
    return this.send(
      phone,
      `Lilia Food : Nouvelle livraison chez ${restaurantName}. Connectez-vous à l'app.`,
    );
  }

  /** Notification livraison imminente au client */
  async sendDeliveryIncoming(phone: string): Promise<boolean> {
    return this.send(
      phone,
      `Lilia Food : Votre livreur arrive dans quelques minutes. Préparez-vous !`,
    );
  }

  private formatNumber(phone: string): string {
    let cleaned = phone.replace(/\s+/g, '').replace(/^\+/, '');
    if (!cleaned.startsWith('242')) cleaned = `242${cleaned}`;
    return `+${cleaned}`;
  }
}