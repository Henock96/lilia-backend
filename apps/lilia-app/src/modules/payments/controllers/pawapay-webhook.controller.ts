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
import * as Sentry from '@sentry/nestjs';

import { resolveTrustedClientIp } from '../../../common/http/client-ip';
import { Public } from '../../auth/decorators/public.decorator';
import { SkipResponseWrap } from '../../../common/interceptors/api-response.interceptor';
import { PaymentService, maskRef } from '../services/payment.service';
import { RestaurantPayoutService } from '../services/restaurant-payout.service';
import { RefundProviderService } from '../../refunds/refund-provider.service';
import { PaymentEventService } from '../services/payment-event.service';
import { PawaPaySignatureService } from '../providers/pawapay/pawapay-signature.service';
import { WebhookReceptionMonitor } from '../services/webhook-reception.monitor';
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
    private readonly refunds: RefundProviderService,
    private readonly events: PaymentEventService,
    private readonly signature: PawaPaySignatureService,
    private readonly config: ConfigService,
    private readonly reception: WebhookReceptionMonitor,
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

      // ⚠️ Deux virements sortants empruntent cette route, et pawaPay ne les
      // distingue pas : il ne connaît qu'un `payoutId`. Le **reversement
      // vendeur** et le **remboursement client** ont pourtant des tables, des
      // bénéficiaires et des conséquences opposés.
      //
      // L'aiguillage se fait par essai successif sur les deux tables, et c'est
      // la seule façon correcte : les deux identifiants sont générés par nous,
      // uniques et disjoints, donc une référence ne peut appartenir qu'à l'un.
      // Le deviner d'après la forme du payload serait une heuristique — et ce
      // contrôleur existe précisément pour n'en faire aucune.
      //
      // Sans cet aiguillage, un remboursement client restait `PROCESSING` pour
      // toujours : le callback arrivait, ne trouvait pas de reversement, et
      // repartait en `unknown-transaction`.
      if (!payout) {
        const refund = await this.refunds.findByProviderRefundId(
          'PAWAPAY',
          externalId,
        );
        if (refund) {
          const outcome = await this.refunds.applyProviderStatus({
            refundId: refund.id,
            status: this.toProviderStatus(payload),
            source: PaymentEventSource.WEBHOOK,
          });
          return { status: this.toResponseStatus(outcome) };
        }

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
          `Callback reversement : aucun reversement NI remboursement pour la ref ${maskRef(externalId)}`,
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
        this.alertRejected(route, `signature:${failure}`);
        throw new UnauthorizedException('Callback non autorisé');
      }
      return;
    }

    // Repli. La signature RFC-9421 est le dispositif de référence : elle prouve
    // l'origine ET l'intégrité du corps, sans rien supposer du réseau. Une liste
    // blanche d'adresses ne prouve que l'origine, et seulement si la topologie
    // garantit qu'on lit la bonne adresse.
    this.logger.warn(
      'Callback pawaPay authentifié par liste blanche d’IP — repli faible. ' +
        'Configurer PAWAPAY_PUBLIC_KEY (signature RFC-9421) en production.',
    );

    const allowlist = (this.config.get<string>('PAWAPAY_CALLBACK_IPS') ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);

    if (allowlist.length === 0) {
      this.logger.error(
        'Aucune authentification de callback configurée ' +
          '(ni PAWAPAY_PUBLIC_KEY ni PAWAPAY_CALLBACK_IPS) — callback refusé',
      );
      this.alertRejected(route, 'not-configured');
      throw new UnauthorizedException('Callback non configuré');
    }

    // ⚠️ Trois pièges se croisent ici, et la fonction appelée les tranche.
    //
    //  1. `req.ip` seul ne convient pas : derrière Cloudflare + Render, il vaut
    //     l'adresse de l'edge, jamais celle de pawaPay — la liste blanche ne
    //     matcherait donc jamais.
    //  2. Augmenter `TRUST_PROXY_HOPS` pour « corriger » cela laisserait forger
    //     l'adresse via `X-Forwarded-For`.
    //  3. Et faire confiance à `CF-Connecting-IP` **sans condition** — ce qui
    //     était le cas — laisse un appelant frapper l'hôte `*.onrender.com` en
    //     direct, poser l'en-tête lui-même, et se faire passer pour le
    //     prestataire sur un endpoint qui écrit de l'argent.
    //
    // D'où `TRUST_CLOUDFLARE_IP_HEADER`, dont le défaut est `false` : tant que
    // personne n'a déclaré la topologie, l'en-tête ne décide de rien.
    const source =
      resolveTrustedClientIp(req, {
        trustCloudflareHeader: this.config.get<boolean>(
          'TRUST_CLOUDFLARE_IP_HEADER',
          false,
        ),
      }) ?? '';
    if (!allowlist.includes(source)) {
      this.logger.error(
        `Callback pawaPay/${route} refusé — adresse ${source} hors liste blanche`,
      );
      this.alertRejected(route, 'ip-not-allowlisted');
      throw new UnauthorizedException('Callback non autorisé');
    }
  }

  /**
   * Rend visible un callback refusé.
   *
   * **Pourquoi cette alerte existe.** Un webhook fail-closed mal configuré est
   * silencieux par nature : il répond 401, pawaPay réessaie quinze minutes puis
   * abandonne, et **rien** dans l'application ne signale que plus aucun
   * paiement n'est confirmé par sa voie normale. C'est exactement ce qui s'est
   * produit — les encaissements n'étaient plus confirmés que par
   * l'interrogation de l'application cliente, avec le cron de réconciliation
   * comme dernier filet. Le jour où un client ferme son application juste après
   * avoir payé, il attend jusqu'à cinq minutes.
   *
   * Un refus est donc toujours une anomalie : soit la configuration est
   * incomplète, soit quelqu'un frappe à la porte. Les deux méritent d'être vus.
   *
   * ⚠️ **Sentry ne suffisait pas.** Une alerte part vers un service tiers que
   * personne n'interroge depuis l'application ; en base, le refus ne laissait
   * *rien*, puisque le 401 est levé avant toute écriture. Résultat :
   * `webhooksEverReceived: 0` se lisait aussi bien comme « le prestataire ne
   * nous appelle pas » que comme « nous refusons tous ses appels » — deux
   * situations qui appellent des gestes opposés. Le compteur ci-dessous rend
   * les deux cas distinguables depuis `GET /admin/payments/webhook-health`.
   */
  private alertRejected(route: string, reason: string) {
    Sentry.captureMessage(
      `pawapay.callback_rejected — ${route} refusé (${reason})`,
      'warning',
    );
    // Best-effort et volontairement non attendu : un refus est une décision de
    // sécurité, elle ne doit pas dépendre de la disponibilité de Redis. Le
    // `catch` est ici, pas seulement dans le moniteur — une promesse rejetée
    // qu'on se contente d'ignorer devient un rejet non capturé, et Node tue le
    // processus.
    void this.reception.recordRejection(route, reason).catch(() => undefined);
  }

  /**
   * Traduit un callback pawaPay en statut normalisé.
   *
   * Extrait parce que trois chemins l'utilisent désormais (dépôt, reversement
   * vendeur, remboursement client) : trois copies finiraient par diverger sur
   * la lecture du montant, qui est déjà subtile (`requestedAmount` d'abord,
   * `amount` en repli).
   */
  private toProviderStatus(payload: PawaPayCallbackDto) {
    return {
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
    };
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
