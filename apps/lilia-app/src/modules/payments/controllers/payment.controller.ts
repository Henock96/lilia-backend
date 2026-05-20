/* eslint-disable prettier/prettier */
import { Controller, Post, Get, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { DecodedIdToken } from 'firebase-admin/auth';

import { PaymentService, CreatePaymentRequest } from '../services/payment.service';
import { FirebaseUser } from '../../auth/decorators/firebase-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';

@ApiBearerAuth()
@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  /**
   * Initie un paiement.
   * En mode MANUAL : retourne les instructions de virement.
   * En mode SANDBOX/MTN_PRODUCTION : initie le Request-to-Pay MTN.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initier un paiement pour une commande' })
  async createPayment(
    @Body() request: CreatePaymentRequest,
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
  confirmPayment(
    @Param('paymentId') paymentId: string,
  ) {
    return this.paymentService.confirmManualPayment(paymentId);
  }
}
