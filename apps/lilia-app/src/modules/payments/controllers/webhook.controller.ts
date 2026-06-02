/* eslint-disable prettier/prettier */
import {
  Controller,
  Post,
  Body,
  Headers,
  Logger,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import * as crypto from 'crypto';
import { PaymentService } from '../services/payment.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { Public } from '../../auth/decorators/public.decorator';
import { ConfigService } from '@nestjs/config';

interface MtnWebhookPayload {
  referenceId: string;
  status: 'SUCCESSFUL' | 'FAILED' | 'PENDING';
  financialTransactionId?: string;
}

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Reçoit les callbacks MTN MoMo.
   * @Public() — pas d'auth Firebase (MTN appelle directement ce endpoint).
   * En production, valider la signature dans les headers.
   */
  @Public()
  @Post('mtn-momo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Callback MTN MoMo (webhook)' })
  async handleMtnMomoWebhook(
    @Body() payload: MtnWebhookPayload,
    @Headers('x-callback-signature') signature?: string,
    @Headers('x-webhook-secret') webhookSecret?: string,
  ) {
    this.logger.log(`Webhook MTN reçu : ${payload.referenceId} → ${payload.status}`);
    this.validateWebhookSecret(signature, webhookSecret, payload);

    try {
      if (payload.status === 'SUCCESSFUL') {
        const payment = await this.prisma.payment.findFirst({
          where: { providerTransactionId: payload.referenceId },
        });

        if (payment) {
          await this.paymentService.checkPaymentStatus(payment.id);
          this.logger.log(`Paiement ${payment.id} traité via webhook`);
        } else {
          this.logger.warn(`Webhook : aucun paiement trouvé pour ref ${payload.referenceId}`);
        }
      }

      return { status: 'received' };
    } catch (error) {
      this.logger.error(`Webhook MTN échoué : ${error.message}`);
      // On retourne 200 quand même pour éviter que MTN retry en boucle
      return { status: 'error', message: error.message };
    }
  }

  /**
   * Validation du webhook MTN MoMo (fix B2).
   *
   * SÉCURITÉ :
   * 1. Fail-closed en production : si MTN_MOMO_WEBHOOK_SECRET est absent en
   *    NODE_ENV=production, on lève une 500 (et on log) au lieu d'accepter
   *    aveuglément. En dev/staging on garde l'ancien comportement (warn).
   * 2. Comparaison avec crypto.timingSafeEqual pour éviter les timing
   *    attacks (l'ancien `received !== expected` était vulnérable).
   * 3. Si l'en-tête `x-callback-signature` est présent, on tente une
   *    vérification HMAC SHA-256 du body. Hypothèse conservatrice : on
   *    n'a pas trouvé de doc officielle MTN décrivant le format de la
   *    signature ; on supporte HMAC SHA-256 hex sur le raw body comme
   *    fallback générique. Si MTN utilise un autre schéma, ce check
   *    rejettera tout — mais c'est volontaire (fail-closed). Tant que la
   *    sig n'est pas certaine, l'opérateur peut ne PAS l'envoyer côté MTN
   *    et s'appuyer uniquement sur `x-webhook-secret`.
   */
  private validateWebhookSecret(
    signature: string | undefined,
    webhookSecret: string | undefined,
    payload?: unknown,
  ) {
    const expected = this.config.get<string>('MTN_MOMO_WEBHOOK_SECRET');
    if (!expected) {
      if (process.env.NODE_ENV === 'production') {
        this.logger.error(
          'MTN_MOMO_WEBHOOK_SECRET manquant en production — webhook rejeté (fail-closed)',
        );
        throw new InternalServerErrorException(
          'Webhook configuration manquante',
        );
      }
      this.logger.warn(
        'MTN_MOMO_WEBHOOK_SECRET non défini (dev/staging) : webhook accepté sans secret partagé',
      );
      return;
    }

    // 1) HMAC signature si fournie (hypothèse : HMAC-SHA256 hex du raw body)
    if (signature && payload !== undefined) {
      const computed = crypto
        .createHmac('sha256', expected)
        .update(JSON.stringify(payload))
        .digest('hex');
      if (this.safeEqual(signature, computed)) {
        return;
      }
      // signature fournie mais invalide → on n'autorise PAS de fallback sur
      // le secret partagé pour éviter de masquer une vraie attaque.
      this.logger.warn('Webhook MTN : signature HMAC invalide');
      throw new UnauthorizedException('Webhook non autorisé');
    }

    // 2) Fallback secret partagé (x-webhook-secret) — timingSafeEqual
    const received = webhookSecret;
    if (!received || !this.safeEqual(received, expected)) {
      throw new UnauthorizedException('Webhook non autorisé');
    }
  }

  /** Compare deux strings en temps constant. Renvoie false si longueurs diffèrent. */
  private safeEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) {
      // timingSafeEqual exige des buffers de même longueur. On renvoie false
      // sans court-circuit visible côté attaquant : on fait quand même un
      // compare de même longueur pour normaliser le timing.
      const dummy = Buffer.alloc(aBuf.length);
      crypto.timingSafeEqual(aBuf, dummy);
      return false;
    }
    return crypto.timingSafeEqual(aBuf, bBuf);
  }
}
