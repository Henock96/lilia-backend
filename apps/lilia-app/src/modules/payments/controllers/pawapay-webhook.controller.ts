import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { PaymentEventKind, PaymentEventSource } from '@prisma/client';
import type { Request } from 'express';

import { Public } from '../../auth/decorators/public.decorator';
import { SkipResponseWrap } from '../../../common/interceptors/api-response.interceptor';
import { PaymentService, maskRef } from '../services/payment.service';
import { RestaurantPayoutService } from '../services/restaurant-payout.service';
import { PaymentEventService } from '../services/payment-event.service';
import { PawaPaySignatureService } from '../providers/pawapay/pawapay-signature.service';
import { PawaPayCallbackDto } from '../dto/pawapay-webhook.dto';
import {
  mapPawaPayState,
  parseAmountToXaf,
} from '../providers/pawapay/pawapay.mapper';

/**
 * Callbacks pawaPay.
 *
 * **Deux routes distinctes, volontairement.** Un dépôt et un reversement se
 * ressemblent en JSON (mêmes champs, statuts identiques) mais aboutissent à des
 * tables et à des conséquences opposées. Un endpoint unique qui devinerait le
 * type d'après la présence de `depositId` ou `payoutId` marcherait — jusqu'au
 * jour où pawaPay ajouterait un champ, ou où un payload en porterait deux. On
 * ne fait pas reposer l'aiguillage entre « créditer une commande » et « acter un
 * virement au vendeur » sur une heuristique.
 *
 * Contrôleur **séparé** de `WebhookController` (MTN) pour la même raison : les
 * schémas de signature diffèrent, et les mélanger dans un fichier invite à
 * réutiliser la mauvaise vérification.
 *
 * Convention de réponse, telle que pawaPay l'attend :
 *  · `200` — callback considéré comme livré, y compris quand on l'ignore
 *    volontairement (transaction inconnue, payload inexploitable) : le rejouer
 *    n'y changerait rien ;
 *  · `5xx` — erreur transitoire, pawaPay rejoue pendant **15 minutes** ;
 *  · `401` — signature absente ou invalide.
 */
@ApiExcludeController()
@Controller('webhooks/pawapay')
// Les callbacks externes reçoivent une réponse JSON brute, sans l'enveloppe
// `{ data, ... }` de l'API.
@SkipResponseWrap()
export class PawaPayWebhookController {
  private readonly logger = new Logger(PawaPayWebhookController.name);

  constructor(
    private readonly payments: PaymentService,
    private readonly payouts: RestaurantPayoutService,
    private readonly events: PaymentEventService,
    private readonly signature: PawaPaySignatureService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('deposits')
  @HttpCode(HttpStatus.OK)
  async handleDepositCallback(
    @Body() payload: PawaPayCallbackDto,
    @Req() req: Request,
  ) {
    this.assertAuthentic(req, 'deposits');

    const externalId = payload.depositId;
    if (!externalId) {
      this.logger.warn('Callback dépôt sans depositId — ignoré');
      return { status: 'ignored', reason: 'missing-depositId' };
    }

    this.logger.log(
      `Callback dépôt pawaPay — ref ${maskRef(externalId)} → ${payload.status}`,
    );

    try {
      const payment = await this.payments.findByProviderTransactionId(
        'PAWAPAY',
        externalId,
      );

      if (!payment) {
        // Transaction inconnue : on garde la trace (c'est le signal d'une fuite
        // de configuration, d'un environnement croisé sandbox/production, ou
        // d'une tentative), mais rien à faire avancer.
        await this.events.record({
          kind: PaymentEventKind.COLLECTION,
          provider: 'PAWAPAY',
          externalId,
          source: PaymentEventSource.WEBHOOK,
          rawStatus: payload.status,
          payload,
          outcome: 'IGNORED',
        });
        this.logger.warn(
          `Callback dépôt : aucun paiement pour la ref ${maskRef(externalId)}`,
        );
        return { status: 'ignored', reason: 'unknown-transaction' };
      }

      const outcome = await this.payments.applyCollectionProviderStatus({
        paymentId: payment.id,
        status: {
          state: mapPawaPayState(payload.status),
          rawStatus: payload.status,
          amountXaf:
            parseAmountToXaf(payload.requestedAmount) ??
            parseAmountToXaf(payload.amount),
          currency: payload.currency,
          providerTransactionId: payload.providerTransactionId,
          failureCode: payload.failureReason?.failureCode,
          failureMessage: payload.failureReason?.failureMessage,
          raw: payload,
        },
        source: PaymentEventSource.WEBHOOK,
      });

      return { status: this.toResponseStatus(outcome) };
    } catch (error) {
      return this.handleProcessingError(error, 'dépôt', externalId);
    }
  }

  @Public()
  @Post('payouts')
  @HttpCode(HttpStatus.OK)
  async handlePayoutCallback(
    @Body() payload: PawaPayCallbackDto,
    @Req() req: Request,
  ) {
    this.assertAuthentic(req, 'payouts');

    const externalId = payload.payoutId;
    if (!externalId) {
      this.logger.warn('Callback reversement sans payoutId — ignoré');
      return { status: 'ignored', reason: 'missing-payoutId' };
    }

    this.logger.log(
      `Callback reversement pawaPay — ref ${maskRef(externalId)} → ${payload.status}`,
    );

    try {
      const payout = await this.payouts.findByProviderPayoutId(
        'PAWAPAY',
        externalId,
      );

      if (!payout) {
        await this.events.record({
          kind: PaymentEventKind.PAYOUT,
          provider: 'PAWAPAY',
          externalId,
          source: PaymentEventSource.WEBHOOK,
          rawStatus: payload.status,
          payload,
          outcome: 'IGNORED',
        });
        this.logger.warn(
          `Callback reversement : aucun reversement pour la ref ${maskRef(externalId)}`,
        );
        return { status: 'ignored', reason: 'unknown-transaction' };
      }

      const outcome = await this.payouts.applyPayoutProviderStatus({
        payoutId: payout.id,
        status: {
          state: mapPawaPayState(payload.status),
          rawStatus: payload.status,
          amountXaf:
            parseAmountToXaf(payload.requestedAmount) ??
            parseAmountToXaf(payload.amount),
          currency: payload.currency,
          providerTransactionId: payload.providerTransactionId,
          failureCode: payload.failureReason?.failureCode,
          failureMessage: payload.failureReason?.failureMessage,
          raw: payload,
        },
        source: PaymentEventSource.WEBHOOK,
      });

      return { status: this.toResponseStatus(outcome) };
    } catch (error) {
      return this.handleProcessingError(error, 'reversement', externalId);
    }
  }

  /**
   * Authentifie le callback.
   *
   * Deux dispositifs, dans l'ordre de préférence :
   *
   *  1. **Signature RFC-9421** dès qu'une clé publique est configurée. C'est la
   *     protection réelle : elle prouve l'origine ET l'intégrité du corps.
   *  2. **Liste blanche d'adresses IP**, en repli, si aucune clé n'est
   *     configurée — les callbacks signés sont optionnels chez pawaPay.
   *
   * Si **aucun** des deux n'est configuré, on refuse tout : cet endpoint est
   * public et modifie des lignes d'argent. Un endpoint de paiement ouvert à
   * n'importe quel appelant est une porte, pas une commodité.
   */
  private assertAuthentic(req: Request, route: string) {
    if (this.signature.isEnabled) {
      const failure = this.signature.verify({
        method: req.method,
        authority: req.get('host') ?? '',
        path: req.originalUrl.split('?')[0],
        rawBody: (req as Request & { rawBody?: Buffer }).rawBody,
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      if (failure) {
        // Le motif reste dans les logs : le détailler à l'appelant l'aiderait à
        // forger une signature valide.
        this.logger.error(
          `Callback pawaPay/${route} refusé — signature invalide (${failure})`,
        );
        throw new UnauthorizedException('Callback non autorisé');
      }
      return;
    }

    const allowlist = (this.config.get<string>('PAWAPAY_CALLBACK_IPS') ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);

    if (allowlist.length === 0) {
      this.logger.error(
        'Aucune authentification de callback configurée ' +
          '(ni PAWAPAY_PUBLIC_KEY ni PAWAPAY_CALLBACK_IPS) — callback refusé',
      );
      throw new UnauthorizedException('Callback non configuré');
    }

    // `req.ip` est fiable grâce à `trust proxy` (fix C4) : sans lui, ce serait
    // l'adresse du load balancer Render, la même pour tout le monde.
    const source = req.ip ?? '';
    if (!allowlist.includes(source)) {
      this.logger.error(
        `Callback pawaPay/${route} refusé — adresse ${source} hors liste blanche`,
      );
      throw new UnauthorizedException('Callback non autorisé');
    }
  }

  private toResponseStatus(
    outcome: 'APPLIED' | 'DUPLICATE' | 'IGNORED' | 'MISMATCH',
  ): string {
    switch (outcome) {
      case 'APPLIED':
        return 'processed';
      case 'DUPLICATE':
        return 'duplicate';
      case 'MISMATCH':
        // 200 volontaire : rejouer ne corrigerait pas un écart de montant. Un
        // incident CRITICAL et une alerte Sentry ont été ouverts, c'est un
        // humain qui doit trancher.
        return 'mismatch';
      default:
        return 'ignored';
    }
  }

  /**
   * Une erreur de traitement est **transitoire** par défaut.
   *
   * On répond 5xx pour que pawaPay rejoue (il le fait pendant 15 minutes) : le
   * traitement est idempotent, un rejeu est donc sans risque. Répondre 200 sur
   * une panne de base ferait considérer le callback comme livré et le paiement
   * ne serait jamais confirmé — un client aurait payé, sa commande expirerait
   * quand même. C'est exactement le défaut corrigé sur le webhook MTN (fix M15).
   */
  private handleProcessingError(
    error: unknown,
    kind: string,
    externalId: string,
  ): never {
    this.logger.error(
      `Traitement du callback ${kind} ${maskRef(externalId)} échoué : ${(error as Error).message}`,
      (error as Error).stack,
    );
    throw new ServiceUnavailableException(
      'Traitement temporairement indisponible — veuillez rejouer ce callback.',
    );
  }
}
