/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MtnMomoService } from './mtn-momo.service';
import { OrderStatus } from '@prisma/client';
import { OrderPaymentConfirmedEvent } from 'src/events/order-events';
//import { OrderPaymentConfirmedEvent } from '../../events/order-events';

export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export interface CreatePaymentRequest {
  orderId: string;
  amount: number;
  currency: string;
  phoneNumber: string;
  payerMessage?: string;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mtnMomoService: MtnMomoService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createPayment(request: CreatePaymentRequest): Promise<{ paymentId: string; referenceId: string }> {
    // Valider le numéro de téléphone
    if (!this.mtnMomoService.validatePhoneNumber(request.phoneNumber)) {
      throw new Error('Invalid phone number format');
    }

    // Récupérer la commande
    const order = await this.prisma.order.findUnique({
      where: { id: request.orderId },
      include: { restaurant: true },
    });

    if (!order) {
      throw new Error('Order not found');
    }

      const validStatuses = ['EN_ATTENTE', 'CONFIRMER'];
      if (!validStatuses.includes(order.status)) {
        throw new Error(`Order cannot be paid in current status: ${order.status}`);
      }

    // Créer l'enregistrement de paiement
    const payment = await this.prisma.payment.create({
      data: {
        orderId: request.orderId,
        amount: request.amount,
        currency: request.currency,
        phoneNumber: this.mtnMomoService.formatPhoneNumber(request.phoneNumber),
        status: PaymentStatus.PENDING,
        provider: 'MTN_MOMO',
        metadata: {},
      },
    });

    try {
      // Initier le paiement avec MTN MoMo
      const referenceId = await this.mtnMomoService.requestToPay({
        amount: request.amount.toString(),
        currency: request.currency,
        externalId: payment.id,
        payer: {
          partyIdType: 'MSISDN',
          partyId: this.mtnMomoService.formatPhoneNumber(request.phoneNumber),
        },
        payerMessage: request.payerMessage || `Paiement commande ${order.id}`,
        payeeNote: `Paiement chez ${order.restaurant.nom}`,
      });

      // Mettre à jour avec la référence MTN
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { 
          providerTransactionId: referenceId,
          metadata: { referenceId }
        },
      });

      this.logger.log(`Payment created: ${payment.id} with MTN reference: ${referenceId}`);

      return {
        paymentId: payment.id,
        referenceId,
      };
    } catch (error) {
      // Marquer le paiement comme échoué
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED },
      });
      
      throw error;
    }
  }

  async checkPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: { include: { restaurant: true } } },
    });

    if (!payment) {
      throw new Error('Payment not found');
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      return PaymentStatus.SUCCESS;
    }

    try {
      // Vérifier le statut chez MTN
      const status = await this.mtnMomoService.getTransactionStatus(payment.providerTransactionId);
      
      let newStatus: PaymentStatus;
      switch (status.status) {
        case 'SUCCESSFUL':
          newStatus = PaymentStatus.SUCCESS;
          break;
        case 'FAILED':
          newStatus = PaymentStatus.FAILED;
          break;
        default:
          newStatus = PaymentStatus.PENDING;
      }

      // Mettre à jour le statut
      if (newStatus !== payment.status) {
        await this.prisma.payment.update({
          where: { id: paymentId },
          data: { 
            status: newStatus,
            metadata: { ...(typeof payment.metadata === 'object' && payment.metadata !== null ? payment.metadata : {}), lastStatusCheck: new Date() }
          },
        });

        // Si le paiement est confirmé, émettre un événement
        if (newStatus === PaymentStatus.SUCCESS) {
          await this.handleSuccessfulPayment(payment);
        }else if (newStatus === PaymentStatus.FAILED) {
          this.eventEmitter.emit('order.payment.failed', {
            orderId: payment.orderId,
            userId: payment.order.userId,
            paymentId: payment.id,
            reason: status.reason || 'Payment failed',
          });
        }
      }

      return newStatus;
    } catch (error) {
      this.logger.error(`Failed to check payment status: ${error.message}`);
      return payment.status as PaymentStatus;
    }
  }

  private async handleSuccessfulPayment(payment: any) {
    // Mettre à jour le statut de la commande
    await this.prisma.order.update({
      where: { id: payment.orderId },
      data: { status: OrderStatus.PAYER, paidAt: new Date(), },
    });

    // Émettre l'événement de paiement confirmé
    const event = new OrderPaymentConfirmedEvent(
      payment.orderId,
      payment.order.userId,
      payment.order.restaurantId,
      payment.id,
      payment.amount,
    );

    this.eventEmitter.emit('order.payment.confirmed', event);
    
    this.logger.log(`Payment confirmed for order: ${payment.orderId}`);
  }

  async handlePaymentTimeout(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });

    if (!payment) return;

    // Marquer comme timeout
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.FAILED,
        metadata: { ...(typeof payment.metadata === 'object' && payment.metadata !== null ? payment.metadata : {}), timeoutAt: new Date() },
      },
    });

    // Émettre l'événement de timeout
    this.eventEmitter.emit('order.payment.timeout', {
      orderId: payment.orderId,
      userId: payment.order.userId,
      paymentId: payment.id,
    });
  }
}