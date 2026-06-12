// sms/sms.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Infobip, AuthType } from '@infobip-api/sdk';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly isEnabled: boolean;
  private readonly sender: string;
  private client: Infobip | null = null;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('INFOBIP_API_KEY');
    const baseUrl = this.config.get<string>('INFOBIP_BASE_URL');
    this.sender = this.config.get<string>('INFOBIP_SENDER', 'LiliaFood');
    this.isEnabled = !!(apiKey && baseUrl);

    if (this.isEnabled) {
      this.client = new Infobip({
        baseUrl: baseUrl as string,
        apiKey: apiKey as string,
        authType: AuthType.ApiKey,
      });
      this.logger.log('SMS service initialise (Infobip)');
    } else {
      this.logger.warn('SMS service desactive — INFOBIP_API_KEY/INFOBIP_BASE_URL manquant');
    }
  }

  /**
   * Envoie un SMS. En mode simule (sans cles) : log uniquement, renvoie true, aucun cout.
   * Ne jette jamais : renvoie false en cas d'echec reel.
   */
  async send(to: string, message: string): Promise<boolean> {
    if (!this.isEnabled || !this.client) {
      this.logger.debug(`[SMS simule] -> ${to} : ${message}`);
      return true;
    }
    try {
      const formatted = this.formatNumber(to);
      await this.client.channels.sms.send({
        messages: [
          { destinations: [{ to: formatted }], from: this.sender, text: message },
        ],
      });
      this.logger.log(`SMS envoye -> ${formatted}`);
      return true;
    } catch (error) {
      this.logger.error(`Echec SMS -> ${to}: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * SMS de bienvenue. Message sans accents et < 160 caracteres => 1 segment GSM-7.
   */
  async sendWelcome(phone: string, nom: string): Promise<boolean> {
    const safeName = (nom || 'client').trim().slice(0, 20);
    return this.send(
      phone,
      `Bienvenue ${safeName} sur Lilia Food ! Commandez vos plats preferes a Brazzaville. A tres vite !`,
    );
  }

  private formatNumber(phone: string): string {
    const cleaned = phone.replace(/\s+/g, '').replace(/^\+/, '');
    // Numero local Congo (ex: 06xxxxxxx) => prefixer 242. Sinon, deja international.
    if (!cleaned.startsWith('242') && /^\d{9}$/.test(cleaned)) {
      return `+242${cleaned}`;
    }
    return `+${cleaned}`;
  }
}
