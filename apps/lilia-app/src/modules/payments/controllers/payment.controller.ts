import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DecodedIdToken } from 'firebase-admin/auth';
import { AdminAuditAction, PaymentEventSource, User } from '@prisma/client';

import { PaymentService } from '../services/payment.service';
import { PaymentEventService } from '../services/payment-event.service';
import { PaymentProviderRegistry } from '../payment-provider.registry';
import { PawaPayHttpService } from '../providers/pawapay/pawapay-http.service';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { RejectPaymentDto } from '../dto/reject-payment.dto';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { FirebaseUser } from '../../auth/decorators/firebase-user.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AdminAuditService } from '../../admin-audit/admin-audit.service';

@ApiTags('Paiements')
@ApiBearerAuth()
@Controller('payments')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly registry: PaymentProviderRegistry,
    private readonly pawapayHttp: PawaPayHttpService,
    private readonly events: PaymentEventService,
    // Confirmer un virement, c'est décider qu'une commande est payée : la trace
    // doit survivre à la rotation des logs (audit du 28/08/2026).
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Opérateurs proposables au client, et leur disponibilité du moment.
   *
   * Alimenté par `GET /v2/active-conf` du prestataire (en cache 15 min), ce qui
   * permet de **griser un opérateur en panne sans publier une release**. Sans
   * cette route, une indisponibilité MTN se traduirait par des échecs de
   * paiement en série et un client qui ne comprend pas pourquoi.
   *
   * Publique, comme `GET /platform-settings` : l'écran de paiement doit pouvoir
   * l'appeler avant même que la commande existe, et elle n'expose rien de
   * sensible.
   */
  @Public()
  @Get('providers')
  @ApiOperation({ summary: 'Opérateurs Mobile Money disponibles' })
  async listProviders() {
    const conf = await this.pawapayHttp.getActiveConfiguration();
    const country = conf?.countries?.find((c) => c.country === 'COG');

    const isOperational = (providerCode: string): boolean => {
      const provider = country?.providers?.find(
        (p) => p.provider === providerCode,
      );
      if (!provider) return true; // pas d'information : on n'interdit pas
      const deposit = provider.currencies
        ?.flatMap((c) => c.operationTypes ?? [])
        .find((op) => 'DEPOSIT' in op || op.operationType === 'DEPOSIT');
      const status =
        (deposit?.DEPOSIT as { status?: string } | undefined)?.status ??
        (deposit?.status as string | undefined);
      return status !== 'CLOSED';
    };

    return {
      mode: this.registry.currentMode,
      operators: [
        {
          code: 'MTN_MOMO',
          label: 'MTN Mobile Money',
          available: isOperational('MTN_MOMO_COG'),
        },
        {
          code: 'AIRTEL_MONEY',
          label: 'Airtel Money',
          available: isOperational('AIRTEL_COG'),
        },
      ],
    };
  }

  /**
   * Initie un encaissement pour une commande.
   *
   * Le montant vient **toujours** de `order.total` ; il n'est pas — et ne doit
   * pas devenir — un champ du corps de requête.
   *
   * Chaque appel peut déclencher une opération facturée chez le prestataire et
   * un message sur le téléphone du client : on borne plus serré que le throttle
   * global (audit 2026-08-01, F-11).
   */
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 10, ttl: 60000 } })
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initier un paiement pour une commande' })
  async createPayment(
    @Body() request: CreatePaymentDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.paymentService.createPayment(request, fbUser.uid);
  }

  /**
   * Statut d'un encaissement.
   *
   * Un statut terminal est lu en base sans appeler le prestataire : l'écran
   * d'attente interroge cette route toutes les trois secondes.
   */
  @Get(':paymentId/status')
  @ApiOperation({ summary: "Statut d'un paiement" })
  async getPaymentStatus(
    @Param('paymentId') paymentId: string,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.paymentService.checkPaymentStatus(paymentId, fbUser.uid);
  }

  /**
   * Confirmation manuelle — ADMIN, mode MANUAL.
   * L'administrateur a retrouvé le virement du client.
   */
  @Post(':paymentId/confirm')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirmer un paiement manuellement (admin)',
    description: "Mode MANUAL — l'administrateur valide le virement reçu.",
  })
  async confirmPayment(
    @Param('paymentId') paymentId: string,
    @CurrentUser() admin: User,
  ) {
    const result = await this.paymentService.confirmManualPayment(paymentId);
    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.PAYMENT_CONFIRMED,
      targetType: 'Payment',
      targetId: paymentId,
    });
    return result;
  }

  /**
   * Rejet manuel — ADMIN, mode MANUAL.
   * La commande reste `EN_ATTENTE` : le client peut réessayer.
   */
  @Post(':paymentId/reject')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rejeter un paiement manuellement (admin)' })
  async rejectPayment(
    @Param('paymentId') paymentId: string,
    @Body() dto: RejectPaymentDto,
    @CurrentUser() admin: User,
  ) {
    const result = await this.paymentService.rejectManualPayment(
      paymentId,
      dto.reason,
    );
    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.PAYMENT_REJECTED,
      targetType: 'Payment',
      targetId: paymentId,
      reason: dto.reason,
    });
    return result;
  }

  /**
   * Force une interrogation du prestataire et applique le résultat.
   *
   * C'est le geste de rattrapage quand un callback s'est perdu et que le cron
   * n'a pas encore tranché. Sans lui, un administrateur face à un paiement bloqué
   * n'a que la base de données et un ticket de support.
   */
  @Post(':paymentId/reconcile')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Réconcilier un paiement auprès du prestataire' })
  async reconcile(
    @Param('paymentId') paymentId: string,
    @CurrentUser() admin: User,
  ) {
    const payment = await this.paymentService.checkPaymentStatus(paymentId);
    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.PAYMENT_CONFIRMED,
      targetType: 'Payment',
      targetId: paymentId,
      reason: 'Réconciliation manuelle auprès du prestataire',
      metadata: { resultingStatus: payment.status },
    });
    return payment;
  }

  /** Journal des signaux prestataire d'un encaissement (lecture seule). */
  @Get(':paymentId/events')
  @Roles('ADMIN')
  @ApiOperation({ summary: "Journal prestataire d'un paiement" })
  async paymentEvents(@Param('paymentId') paymentId: string) {
    const rows = await this.events.listForPayment(paymentId);
    if (rows.length === 0) {
      // Distinguer « aucun signal » d'un identifiant erroné évite de faire
      // chercher un administrateur dans la mauvaise direction.
      const exists = await this.paymentService
        .checkPaymentStatus(paymentId)
        .catch(() => null);
      if (!exists) throw new NotFoundException('Paiement introuvable.');
    }
    return { data: rows, meta: { source: PaymentEventSource.WEBHOOK } };
  }
}
