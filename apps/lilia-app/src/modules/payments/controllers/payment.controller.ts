/* eslint-disable prettier/prettier */
import { Controller, Post, Get, Body, Param, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DecodedIdToken } from 'firebase-admin/auth';

import { PaymentService, CreatePaymentRequest } from '../services/payment.service';
import { FirebaseUser } from '../../auth/decorators/firebase-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';

@Controller('payments')
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
  async createPayment(@Body() request: CreatePaymentRequest) {
    return this.paymentService.createPayment(request);
  }

  /**
   * Vérifie le statut d'un paiement.
   * En mode MANUAL : retourne PENDING jusqu'à confirmation admin.
   * En mode MTN : interroge l'API MTN.
   */
  @Get(':paymentId/status')
  @ApiOperation({ summary: 'Statut d\'un paiement' })
  async getPaymentStatus(@Param('paymentId') paymentId: string) {
    const status = await this.paymentService.checkPaymentStatus(paymentId);
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
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.paymentService.confirmManualPayment(paymentId);
  }
}