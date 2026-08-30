/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentService } from '../services/payment.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { Public } from '../../auth/decorators/public.decorator';
import { SkipResponseWrap } from '../../../common/interceptors/api-response.interceptor';
import { ConfigService } from '@nestjs/config';
import { MtnWebhookDto, MtnWebhookStatus } from '../dto/mtn-webhook.dto';

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
   */
  @Public()
  @Post('mtn-momo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Callback MTN MoMo (webhook)' })
  async handleMtnMomoWebhook(
    @Body() payload: MtnWebhookDto,
    @Headers('x-callback-signature') signature?: string,
    @Headers('x-webhook-secret') webhookSecret?: string,
  ) {
    this.logger.log(`Webhook MTN reçu : ref ${maskRef(payload.referenceId)} → ${payload.status}`);
    this.validateWebhookSecret(signature, webhookSecret);

    try {
      if (payload.status === MtnWebhookStatus.SUCCESSFUL) {
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
      // Fix M15 : on répondait 200 sur TOUTE erreur, « pour éviter que MTN
      // retry en boucle ». Conséquence : un incident base de données faisait
      // répondre 200, MTN considérait le callback livré, ne le rejouait
      // jamais — et le paiement n'était jamais confirmé. Un client avait payé,
      // sa commande expirait quand même.
      //
      // On distingue donc les deux familles :
      //  - erreur PERMANENTE (payload inexploitable) → 200, rejouer n'aiderait
      //    pas ;
      //  - erreur TRANSITOIRE (DB, Redis, API MTN injoignable) → 500, pour que
      //    MTN rejoue. Le traitement est idempotent (`updateMany` conditionnel
      //    dans `handleSuccessfulPayment`), un rejeu est donc sans risque.
      if (this.isPermanentError(error)) {
        return { status: 'error', message: 'payload non traitable' };
      }

      throw new ServiceUnavailableException(
        'Traitement temporairement indisponible — veuillez rejouer ce callback.',
      );
    }
  }

  /**
   * Une erreur permanente est une erreur que rejouer le même callback ne
   * corrigera pas : payload invalide, ressource définitivement absente.
   */
  private isPermanentError(error: unknown): boolean {
    return (
      error instanceof BadRequestException || error instanceof NotFoundException
    );
  }

  /**
   * Validation du webhook MTN MoMo (fix B2).
   * Fail-CLOSED : sans secret configuré, on refuse (ce endpoint est @Public()
   * et mute Payment + Order). Comparaison à temps constant (timingSafeEqual).
   */
  private validateWebhookSecret(signature?: string, webhookSecret?: string) {
    const expected = this.config.get<string>('MTN_MOMO_WEBHOOK_SECRET');
    if (!expected) {
      this.logger.error('MTN_MOMO_WEBHOOK_SECRET non défini — webhook rejeté');
      throw new UnauthorizedException('Webhook non configuré');
    }

    const received = webhookSecret || signature;
    if (!received || !this.safeEqual(received, expected)) {
      throw new UnauthorizedException('Webhook non autorisé');
    }
  }

  /** Comparaison à temps constant (anti timing-attack). False si longueurs diffèrent. */
  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
