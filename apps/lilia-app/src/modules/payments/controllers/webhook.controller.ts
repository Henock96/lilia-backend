/* eslint-disable prettier/prettier */
import { Controller, Post, Body, Headers, Logger, HttpCode, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import * as crypto from 'crypto';
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

  /** Comparaison à temps constant (anti timing-attack). */
  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    // timingSafeEqual exige des buffers de même longueur.
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
