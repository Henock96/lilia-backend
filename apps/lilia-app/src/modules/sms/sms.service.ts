// sms/sms.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Infobip, AuthType } from '@infobip-api/sdk';
import * as Sentry from '@sentry/nestjs';

/**
 * Issue d'une demande d'envoi.
 *
 * Trois valeurs et non un booléen, parce que les appelants doivent distinguer
 * deux situations que `false` confondrait — et que `true` confondait avant
 * septembre 2026 :
 *
 *  · `SENT`    — Infobip a **accepté** le message pour livraison ;
 *  · `SKIPPED` — le service n'est pas configuré, rien n'a été tenté, rien ne
 *                sera jamais tenté tant que les clés manquent ;
 *  · `FAILED`  — une tentative a eu lieu et a échoué (refus opérateur, compte
 *                d'essai, clé révoquée, réseau).
 *
 * `SKIPPED` et `FAILED` interdisent tous deux d'acquitter quoi que ce soit ;
 * seul `SENT` en donne le droit.
 */
export type SmsOutcome = 'SENT' | 'SKIPPED' | 'FAILED';

/**
 * Groupes de statut Infobip considérés comme une acceptation.
 *
 * `0 ACCEPTED`, `1 PENDING`, `3 DELIVERED`. Les trois autres — `2
 * UNDELIVERABLE`, `4 EXPIRED`, `5 REJECTED` — sont des échecs.
 *
 * ⚠️ La réponse de `/sms/2/text/advanced` n'est **pas** un accusé de livraison :
 * un `1 PENDING` dit seulement qu'Infobip a pris le message en charge. C'est le
 * maximum vérifiable de façon synchrone, et c'est déjà infiniment plus que ce
 * que faisait ce service, qui ne regardait rien.
 */
const ACCEPTED_GROUP_IDS = new Set([0, 1, 3]);
const ACCEPTED_GROUP_NAMES = new Set(['ACCEPTED', 'PENDING', 'DELIVERED']);

/** Forme utile de la réponse d'Infobip. Volontairement partielle et défensive. */
interface InfobipSendResponse {
  data?: {
    messages?: {
      to?: string;
      messageId?: string;
      status?: {
        groupId?: number;
        groupName?: string;
        name?: string;
        description?: string;
      };
    }[];
  };
}

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
      this.logger.log(
        `SMS service initialise (Infobip, expediteur ${this.sender})`,
      );
    } else {
      this.logger.warn(
        'SMS service desactive — INFOBIP_API_KEY/INFOBIP_BASE_URL manquant',
      );
    }
  }

  /**
   * Envoie un SMS. Ne jette jamais : rend l'issue.
   *
   * ⚠️ **Le retour d'Infobip est lu, et c'est tout le sujet.** Le SDK
   * (`@infobip-api/sdk`) fait un simple `axios.post` et rend la réponse telle
   * quelle ; axios ne lève que sur un statut HTTP non-2xx. Or Infobip répond
   * **200** pour un lot dont les messages individuels sont *rejetés* — le
   * verdict est dans `messages[].status.groupId`.
   *
   * Sans ce contrôle, un compte d'essai (qui ne livre qu'aux numéros
   * pré-vérifiés), un expéditeur alphanumérique non enregistré pour le +242 ou
   * un opérateur qui refuse produisaient un « envoi réussi » parfaitement
   * silencieux — et les appelants écrivaient `welcomeSmsSentAt` ou
   * `escalatedAt` sur du vide. C'est exactement le défaut déjà corrigé côté
   * Resend (`EmailService.sendEmail` lit `{ data, error }`), qui n'avait jamais
   * été propagé ici.
   */
  async send(to: string, message: string): Promise<SmsOutcome> {
    if (!this.isEnabled || !this.client) {
      this.logger.debug(`[SMS non configure] -> ${to} : ${message}`);
      return 'SKIPPED';
    }

    const formatted = this.formatNumber(to);

    let response: InfobipSendResponse;
    try {
      response = (await this.client.channels.sms.send({
        messages: [
          {
            destinations: [{ to: formatted }],
            from: this.sender,
            text: message,
          },
        ],
      })) as InfobipSendResponse;
    } catch (error) {
      // Non-2xx : clé révoquée, quota, réseau. Le seul cas que l'ancienne
      // version attrapait.
      this.logger.error(
        `Echec SMS -> ${formatted}: ${(error as Error).message}`,
      );
      Sentry.captureException(error, {
        tags: { feature: 'sms', provider: 'infobip' },
      });
      return 'FAILED';
    }

    return this.interpret(response, formatted);
  }

  /**
   * Traduit la réponse d'un envoi en issue.
   *
   * Une réponse **illisible** rend `FAILED`, délibérément : une absence de
   * preuve n'est pas une preuve d'envoi, et c'est précisément en traitant
   * l'inconnu comme un succès que le défaut d'origine est passé inaperçu. Le
   * log est bruyant pour que le cas soit diagnosticable plutôt que silencieux.
   */
  private interpret(
    response: InfobipSendResponse,
    formatted: string,
  ): SmsOutcome {
    const status = response?.data?.messages?.[0]?.status;

    if (!status || (status.groupId === undefined && !status.groupName)) {
      this.logger.error(
        `Reponse Infobip illisible pour ${formatted} — envoi NON confirme : ${JSON.stringify(response?.data ?? null)}`,
      );
      Sentry.captureMessage(
        'sms.unreadable_response — réponse Infobip sans statut exploitable',
        'warning',
      );
      return 'FAILED';
    }

    const accepted =
      (status.groupId !== undefined &&
        ACCEPTED_GROUP_IDS.has(status.groupId)) ||
      (!!status.groupName &&
        ACCEPTED_GROUP_NAMES.has(status.groupName.toUpperCase()));

    if (!accepted) {
      this.logger.error(
        `SMS refuse -> ${formatted} : ${status.groupName ?? 'groupe inconnu'}/` +
          `${status.name ?? 'n/a'} — ${status.description ?? 'sans description'}`,
      );
      Sentry.captureMessage(
        `sms.rejected — ${status.groupName ?? status.groupId}/${status.name ?? 'n/a'}`,
        'warning',
      );
      return 'FAILED';
    }

    this.logger.log(
      `SMS accepte -> ${formatted} (${status.groupName ?? status.groupId})`,
    );
    return 'SENT';
  }

  /**
   * SMS de bienvenue. Message sans accents et < 160 caracteres => 1 segment GSM-7.
   */
  async sendWelcome(phone: string, nom: string): Promise<SmsOutcome> {
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
