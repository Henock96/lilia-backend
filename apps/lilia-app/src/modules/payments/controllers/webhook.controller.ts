/* eslint-disable prettier/prettier */
import { Controller, Post, Body, Headers, Logger, HttpCode, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentService } from '../services/payment.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { Public } from '../../auth/decorators/public.decorator';
import { SkipResponseWrap } from '../../../common/interceptors/api-response.interceptor';
import { ConfigService } from '@nestjs/config';

interface MtnWebhookPayload {
  referenceId: string;
  status: 'SUCCESSFUL' | 'FAILED' | 'PENDING';
  financialTransactionId?: string;
}

/** Masque une référence de transaction pour les logs : garde les 4 derniers. */
function maskRef(ref?: string): string {
  if (!ref) return 'n/a';
  return ref.length <= 4 ? '****' : `****${ref.slice(-4)}`;
}

@ApiTags('Webhooks')
@Controller('webhooks')
// Les webhooks externes (MTN MoMo, Airtel…) doivent recevoir une réponse JSON
// brute exactement comme avant — pas d'enveloppe `{ data, ... }`. Voir
// `docs/api/2026-06-02-J2-api-contract-v2.md`.
@SkipResponseWrap()
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
    this.logger.log(`Webhook MTN reçu : ref ${maskRef(payload.referenceId)} → ${payload.status}`);
    this.validateWebhookSecret(signature, webhookSecret);

    try {
      if (payload.status === 'SUCCESSFUL') {
        const payment = await this.prisma.payment.findFirst({
          where: { providerTransactionId: payload.referenceId },
        });

        if (payment) {
          await this.paymentService.checkPaymentStatus(payment.id);
          this.logger.log(`Paiement ${payment.id} traité via webhook`);
        } else {
          this.logger.warn(`Webhook : aucun paiement trouvé pour ref ${maskRef(payload.referenceId)}`);
        }
      }

      return { status: 'received' };
    } catch (error) {
      this.logger.error(`Webhook MTN échoué : ${error.message}`);
      // On retourne 200 quand même pour éviter que MTN retry en boucle
      return { status: 'error', message: error.message };
    }
  }

  private validateWebhookSecret(signature?: string, webhookSecret?: string) {
    const expected = this.config.get<string>('MTN_MOMO_WEBHOOK_SECRET');
    if (!expected) {
      // Fail-CLOSED : sans secret configuré, on refuse. Ce endpoint est @Public()
      // et mute Payment + Order — l'accepter sans secret laisserait n'importe qui
      // confirmer un paiement arbitraire.
      this.logger.error('MTN_MOMO_WEBHOOK_SECRET non défini — webhook rejeté');
      throw new UnauthorizedException('Webhook non configuré');
    }

    const received = webhookSecret || signature;
    if (!received || !this.safeEqual(received, expected)) {
      throw new UnauthorizedException('Webhook non autorisé');
    }
  }

  /** Comparaison à temps constant (anti timing-attack). */
  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    // timingSafeEqual exige des buffers de même longueur.
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
