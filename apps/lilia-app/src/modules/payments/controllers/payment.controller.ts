/* eslint-disable prettier/prettier */
import { Controller, Post, Get, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DecodedIdToken } from 'firebase-admin/auth';

import { PaymentService } from '../services/payment.service';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { RejectPaymentDto } from '../dto/reject-payment.dto';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AdminAuditService } from '../../admin-audit/admin-audit.service';
import { AdminAuditAction, User } from '@prisma/client';
import { FirebaseUser } from '../../auth/decorators/firebase-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';

@ApiBearerAuth()
@Controller('payments')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    // Confirmer un virement, c'est décider qu'une commande est payée : la
    // trace doit survivre à la rotation des logs (audit du 28/08/2026).
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Initie un paiement.
   * En mode MANUAL : retourne les instructions de virement.
   * En mode SANDBOX/MTN_PRODUCTION : initie le Request-to-Pay MTN.
   */
  // Chaque appel peut déclencher un Request-to-Pay MTN facturé : on borne plus
  // serré que le throttle global (audit 2026-08-01, F-11).
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
   * Vérifie le statut d'un paiement.
   * En mode MANUAL : retourne PENDING jusqu'à confirmation admin.
   * En mode MTN : interroge l'API MTN.
   */
  @Get(':paymentId/status')
  @ApiOperation({ summary: 'Statut d\'un paiement' })
  async getPaymentStatus(
    @Param('paymentId') paymentId: string,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    const status = await this.paymentService.checkPaymentStatus(paymentId, fbUser.uid);
    return { paymentId, status };
  }
  /**
   * Confirmation manuelle — ADMIN uniquement, mode MANUAL.
   * L'admin vérifie le virement et confirme le paiement.
   */
  @Post(':paymentId/confirm')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirmer un paiement manuellement (admin)',
    description: 'Utilisé en mode MANUAL — l\'admin valide le virement MTN reçu.',
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
   * Rejet manuel — ADMIN uniquement, mode MANUAL.
   * L'admin n'a pas retrouvé le virement et rejette le paiement.
   * La commande reste EN_ATTENTE (le client peut réessayer).
   */
  @Post(':paymentId/reject')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rejeter un paiement manuellement (admin)',
    description: 'Utilisé en mode MANUAL — l\'admin n\'a pas retrouvé le virement MTN.',
  })
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
}
