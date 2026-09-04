import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { AdminAuditAction, PayoutStatus, User } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AdminAuditService } from '../../admin-audit/admin-audit.service';
import { RestaurantPayoutService } from '../services/restaurant-payout.service';
import { PaymentEventService } from '../services/payment-event.service';
import { maskPhone } from '../services/payment.service';
import {
  ListPayoutsQueryDto,
  RequestPayoutDto,
  UpdatePayoutAccountDto,
} from '../dto/payout.dto';
import { toMsisdn } from '../providers/pawapay/pawapay.mapper';
import { PawaPaySignatureService } from '../providers/pawapay/pawapay-signature.service';
import { PlatformSettingsService } from '../../platform-settings/platform-settings.service';

/**
 * Reversement des vendeurs — **réservé à l'ADMIN**.
 *
 * Les gardes sont ceux de la plateforme : `FirebaseAuthGuard` puis `RolesGuard`,
 * tous deux en `APP_GUARD`. `@Roles('ADMIN')` suffit à interdire l'accès aux
 * rôles CLIENT, RESTAURATEUR et LIVREUR — aucun second dispositif
 * d'autorisation n'est introduit ici.
 *
 * Toute opération qui envoie de l'argent est tracée dans `AdminAuditLog` : un
 * virement vers un tiers doit laisser une trace nominative opposable, comme la
 * confirmation manuelle d'un encaissement.
 */
@ApiTags('Admin — Reversements')
@ApiBearerAuth()
@Controller('admin')
@Roles('ADMIN')
export class AdminPayoutController {
  constructor(
    private readonly payouts: RestaurantPayoutService,
    private readonly events: PaymentEventService,
    private readonly audit: AdminAuditService,
    private readonly prisma: PrismaService,
    private readonly signature: PawaPaySignatureService,
    private readonly config: ConfigService,
    private readonly settingsService: PlatformSettingsService,
  ) {}

  /**
   * Récapitulatif financier d'une commande : ce que paie le client, ce que
   * touche le vendeur, ce que garde Lilia Food, ce que coûte le prestataire.
   *
   * Porte aussi l'éligibilité au reversement et son motif — c'est cette réponse
   * qui alimente le bouton « Payer le restaurant » et son état désactivé.
   */
  @Get('orders/:orderId/financials')
  @ApiOperation({ summary: "Récapitulatif financier d'une commande" })
  async getFinancials(@Param('orderId') orderId: string) {
    return this.payouts.getOrderFinancials(orderId);
  }

  /**
   * Déclenche le reversement du vendeur.
   *
   * ⚠️ **Seul point du système qui envoie de l'argent à un vendeur.** Aucun
   * événement métier ne le déclenche : ni la confirmation du paiement, ni le
   * passage à `PAYER`, ni le passage à `PRET`. `PRET` rend la commande
   * éligible ; c'est ce clic qui décide.
   *
   * Throttle serré : chaque appel peut déclencher un virement facturé.
   */
  @Throttle({ short: { limit: 1, ttl: 2000 }, long: { limit: 30, ttl: 60000 } })
  @Post('orders/:orderId/payout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Payer le restaurant pour cette commande' })
  async requestPayout(
    @Param('orderId') orderId: string,
    @Body() dto: RequestPayoutDto,
    @CurrentUser() admin: User,
  ) {
    const result = await this.payouts.requestPayout({
      orderId,
      adminUserId: admin.id,
    });

    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.PAYOUT_REQUESTED,
      targetType: 'Order',
      targetId: orderId,
      reason: dto.note,
      metadata: {
        payoutId: result.payout.id,
        restaurantId: result.payout.restaurantId,
        grossAmount: result.payout.grossAmount,
        commissionPercent: result.payout.commissionPercent,
        commissionAmount: result.payout.commissionAmount,
        amount: result.payout.amount,
        currency: result.payout.currency,
        status: result.status,
      },
    });

    return result;
  }

  /**
   * Nouvelle tentative après un échec.
   *
   * Refusée tant que le reversement est `PENDING` ou `SUCCESS` : réessayer un
   * virement peut-être déjà parti est le seul moyen de payer deux fois un
   * vendeur, et cet argent-là ne revient pas.
   */
  @Throttle({ short: { limit: 1, ttl: 2000 }, long: { limit: 30, ttl: 60000 } })
  @Post('orders/:orderId/payout/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Réessayer un reversement échoué' })
  async retryPayout(
    @Param('orderId') orderId: string,
    @Body() dto: RequestPayoutDto,
    @CurrentUser() admin: User,
  ) {
    const result = await this.payouts.retryPayout({
      orderId,
      adminUserId: admin.id,
    });

    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.PAYOUT_RETRIED,
      targetType: 'Order',
      targetId: orderId,
      reason: dto.note,
      metadata: {
        payoutId: result.payout.id,
        amount: result.payout.amount,
        status: result.status,
      },
    });

    return result;
  }

  /** File des reversements, filtrable par statut et par vendeur. */
  @Get('payouts')
  @ApiOperation({ summary: 'Liste des reversements vendeurs' })
  async listPayouts(@Query() query: ListPayoutsQueryDto) {
    return this.payouts.list({
      status: query.status,
      restaurantId: query.restaurantId,
      page: query.page,
      limit: query.limit,
    });
  }

  /**
   * Journal des signaux reçus du prestataire pour un reversement.
   * Lecture seule — la table n'est jamais modifiée par l'application.
   */
  @Get('payouts/:payoutId/events')
  @ApiOperation({ summary: "Journal prestataire d'un reversement" })
  async payoutEvents(@Param('payoutId') payoutId: string) {
    return { data: await this.events.listForPayout(payoutId) };
  }

  /**
   * Coordonnées Mobile Money de reversement d'un vendeur.
   *
   * ⚠️ Réservé à l'ADMIN, et **volontairement absent** de `UpdateRestaurantDto`
   * (ouvert au RESTAURATEUR) : le numéro sur lequel un vendeur est payé ne doit
   * pas être modifiable depuis son propre compte. Un compte compromis
   * détournerait tous les reversements suivants sans qu'aucune alerte ne parte.
   *
   * Le numéro est normalisé au format attendu par le prestataire (chiffres,
   * indicatif inclus) avant enregistrement : le convertir à chaque envoi
   * laisserait la base dans deux formats et rendrait toute vérification humaine
   * pénible.
   */
  @Patch('vendors/:restaurantId/payout-account')
  @ApiOperation({ summary: 'Configurer le compte de reversement d’un vendeur' })
  async updatePayoutAccount(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: UpdatePayoutAccountDto,
    @CurrentUser() admin: User,
  ) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true, nom: true, payoutPhoneNumber: true },
    });
    if (!restaurant) throw new NotFoundException('Vendeur introuvable.');

    const normalized = toMsisdn(dto.payoutPhoneNumber);

    const updated = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        payoutPhoneNumber: normalized,
        payoutProvider: dto.payoutProvider,
        payoutAccountName: dto.payoutAccountName ?? null,
        payoutVerifiedAt: new Date(),
        payoutVerifiedById: admin.id,
      },
      select: {
        id: true,
        nom: true,
        payoutPhoneNumber: true,
        payoutProvider: true,
        payoutAccountName: true,
        payoutVerifiedAt: true,
      },
    });

    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.VENDOR_PAYOUT_ACCOUNT_UPDATED,
      targetType: 'Restaurant',
      targetId: restaurantId,
      metadata: {
        // Le numéro complet ne va pas dans le journal : masqué suffit à
        // reconstituer un changement, et le journal est consultable.
        from: maskPhone(restaurant.payoutPhoneNumber ?? undefined),
        to: maskPhone(normalized),
        provider: dto.payoutProvider,
      },
    });

    return {
      data: {
        ...updated,
        payoutPhoneNumber: maskPhone(updated.payoutPhoneNumber ?? undefined),
      },
      message: 'Compte de reversement enregistré.',
    };
  }

  /**
   * Reversements en attente, groupés par vendeur — vue « qui attend son argent ».
   */
  @Get('payouts/pending-summary')
  @ApiOperation({ summary: 'Reversements en attente par vendeur' })
  async pendingSummary() {
    const pending = await this.prisma.restaurantPayout.groupBy({
      by: ['restaurantId', 'status'],
      where: { status: { in: [PayoutStatus.PENDING, PayoutStatus.FAILED] } },
      _count: { _all: true },
      _sum: { amount: true },
    });
    return { data: pending };
  }

  /**
   * Qui peut être payé, et qui ne peut pas.
   *
   * **Pourquoi cette liste existe.** `PATCH /admin/vendors/:id/payout-account`
   * existait déjà, avec son écran dans les deux administrations. Ce qui
   * manquait, c'était de savoir *sur quels vendeurs* l'utiliser : rien
   * n'affichait qu'un vendeur n'avait pas de compte de reversement, et les six
   * de production sont restés à `NULL` pendant des mois pendant que les
   * commandes s'encaissaient.
   *
   * Un vendeur en tête de liste ici est un vendeur qui accumule une dette :
   * `pendingPayouts` chiffre ce qu'on lui doit déjà.
   */
  @Get('payouts/vendor-accounts')
  @ApiOperation({ summary: 'Comptes de reversement des vendeurs (état)' })
  async vendorPayoutAccounts() {
    const vendors = await this.prisma.restaurant.findMany({
      select: {
        id: true,
        nom: true,
        isActive: true,
        adminApproved: true,
        onboardingStatus: true,
        payoutPhoneNumber: true,
        payoutProvider: true,
        payoutAccountName: true,
        payoutVerifiedAt: true,
        commissionPercent: true,
      },
      orderBy: { nom: 'asc' },
    });

    // Commandes payées, non annulées, sans reversement abouti — la dette réelle.
    const owed = await this.prisma.order.groupBy({
      by: ['restaurantId'],
      where: {
        paidAt: { not: null },
        status: { not: 'ANNULER' },
        payout: { is: null },
      },
      _count: { _all: true },
      _sum: { subTotal: true },
    });
    const owedBy = new Map(owed.map((o) => [o.restaurantId, o]));

    const settings = await this.settingsService.getSettings();

    return {
      data: vendors.map((v) => {
        const debt = owedBy.get(v.id);
        return {
          id: v.id,
          nom: v.nom,
          isActive: v.isActive,
          adminApproved: v.adminApproved,
          onboardingStatus: v.onboardingStatus,
          payable: Boolean(v.payoutPhoneNumber && v.payoutProvider),
          payoutPhoneNumber: maskPhone(v.payoutPhoneNumber ?? undefined),
          payoutProvider: v.payoutProvider,
          payoutAccountName: v.payoutAccountName,
          payoutVerifiedAt: v.payoutVerifiedAt,
          // `null` n'est pas un trou : c'est « taux plateforme ». On rend les
          // deux pour que l'écran n'ait pas à connaître cette convention.
          commissionPercent:
            v.commissionPercent ?? settings.restaurantCommissionPercent,
          commissionIsPlatformDefault: v.commissionPercent === null,
          unpaidOrders: debt?._count._all ?? 0,
          unpaidSubTotal: debt?._sum.subTotal ?? 0,
        };
      }),
    };
  }

  /**
   * Santé de la chaîne d'encaissement, du point de vue des signaux reçus.
   *
   * **Ce que cette route rend visible.** Un callback prestataire non configuré
   * ne casse rien de visible : l'application cliente sonde le statut, le cron
   * de réconciliation rattrape le reste, et les commandes finissent par
   * basculer. Le défaut ne se manifeste que sur le client qui ferme son
   * application juste après avoir payé — et il est alors impossible de
   * distinguer « le callback n'arrive pas » de « ce paiement-là a échoué ».
   *
   * L'audit du 4 septembre 2026 a dû interroger la base de production en SQL
   * pour établir que `PaymentEvent WHERE source='WEBHOOK'` valait **0 depuis le
   * premier jour**. Aucune interface ne pouvait le dire. C'est ce trou-là que
   * cette route ferme : elle ne corrige rien, elle rend l'anomalie lisible.
   *
   * `authentication` décrit le dispositif **effectivement armé** : sans clé
   * publique ni liste blanche d'IP, le webhook est fail-closed et répond 401 à
   * tout — cas dans lequel l'absence de signal est garantie, pas probable.
   */
  @Get('payments/webhook-health')
  @ApiOperation({ summary: 'Réception des callbacks prestataire (diagnostic)' })
  async webhookHealth(@Query('days') daysRaw?: string) {
    const days = Math.min(Math.max(Number(daysRaw) || 7, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [bySource, lastWebhookAt, allTimeWebhooks] = await Promise.all([
      this.events.countBySource(since),
      this.events.lastWebhookAt(),
      this.prisma.paymentEvent.count({ where: { source: 'WEBHOOK' } }),
    ]);

    const signatureConfigured = this.signature.isEnabled;
    const allowlist = (this.config.get<string>('PAWAPAY_CALLBACK_IPS') ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);

    return {
      data: {
        paymentMode: this.config.get<string>('PAYMENT_MODE') ?? 'MANUAL',
        authentication: {
          // Fail-closed : sans l'un des deux, tout callback est refusé en 401.
          configured: signatureConfigured || allowlist.length > 0,
          signature: signatureConfigured,
          ipAllowlistEntries: allowlist.length,
        },
        callbackUrls: {
          deposits: '/webhooks/pawapay/deposits',
          payouts: '/webhooks/pawapay/payouts',
        },
        windowDays: days,
        eventsBySource: bySource,
        lastWebhookAt,
        /**
         * Le critère de sortie du blocker P0-3 : tant qu'il vaut 0, la chaîne
         * de paiement n'a jamais été bouclée par sa voie nominale.
         */
        webhooksEverReceived: allTimeWebhooks,
      },
    };
  }
}
