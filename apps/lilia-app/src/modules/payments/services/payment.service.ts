/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MtnMomoService } from './mtn-momo.service';
import { OrderStatus } from '@prisma/client';
import { OrderPaymentConfirmedEvent } from '../../events/order-events';
import { ConfigService } from '@nestjs/config';

export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}
export enum PaymentMode {
  SANDBOX = 'SANDBOX',        // MTN MoMo sandbox (tests)
  MANUAL = 'MANUAL',          // Virement manuel vers numéro Lilia Food
  MTN_PRODUCTION = 'MTN_PRODUCTION', // Quand agrément obtenu
}
export interface CreatePaymentRequest {
  orderId: string;
  amount?: number;
  currency?: string;
  phoneNumber: string;
  payerMessage?: string;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly mode: PaymentMode;
  private readonly manualPaymentNumber: string;
  constructor(
    private readonly prisma: PrismaService,
    private readonly mtnMomoService: MtnMomoService,
    private readonly eventEmitter: EventEmitter2,
    private readonly config: ConfigService,
  ) {
    this.mode = this.config.get<PaymentMode>('PAYMENT_MODE', PaymentMode.MANUAL);
    this.manualPaymentNumber = this.config.get<string>('LILIA_PAYMENT_PHONE', '');
  }

  async createPayment(request: CreatePaymentRequest, firebaseUid: string) {
    switch (this.mode) {
      case PaymentMode.MANUAL:
        return this.createManualPayment(request, firebaseUid);
      case PaymentMode.SANDBOX:
      case PaymentMode.MTN_PRODUCTION:
        return this.createMtnPayment(request, firebaseUid);
      default:
        throw new BadRequestException(`Mode de paiement invalide: ${this.mode}`);
    }
  }
  async createMtnPayment(request: CreatePaymentRequest, firebaseUid: string): Promise<{ paymentId: string; referenceId: string }> {
    const order = await this.getPayableOrder(request.orderId, firebaseUid);
    const amount = order.total;
    const currency = 'XAF';

    this.logger.log(`💰 [PAIEMENT] Début - commande: ${request.orderId}, montant: ${amount} ${currency}, tel: ${request.phoneNumber}`);

    // Valider le numéro de téléphone
    if (!this.mtnMomoService.validatePhoneNumber(request.phoneNumber)) {
      this.logger.warn(`💰 [PAIEMENT] Échec: numéro invalide "${request.phoneNumber}" - commande: ${request.orderId}`);
      throw new Error('Invalid phone number format');
    }
    await this.assertNoPendingPayment(order.id);

    // Créer l'enregistrement de paiement
    const payment = await this.prisma.payment.create({
      data: {
        orderId: request.orderId,
        amount,
        currency,
        phoneNumber: this.mtnMomoService.formatPhoneNumber(request.phoneNumber),
        status: PaymentStatus.PENDING,
        provider: 'MTN_MOMO',
        metadata: {},
      },
    });

    try {
      // Initier le paiement avec MTN MoMo
      const referenceId = await this.mtnMomoService.requestToPay({
        amount: amount.toString(),
        currency,
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
        // ⚠️ LOG DÉTAILLÉ DE L'ERREUR
      this.logger.error('❌ Payment request failed');
      this.logger.error('Status:', error.response?.status);
      this.logger.error('Status Text:', error.response?.statusText);
      this.logger.error('Error Data:', JSON.stringify(error.response?.data, null, 2));
      this.logger.error('Request Headers:', JSON.stringify(error.config?.headers, null, 2));
      this.logger.error('Request Body:', JSON.stringify(error.config?.data, null, 2));
      throw new HttpException(
      {
        message: 'Payment request failed',
        details: error.response?.data,
        status: error.response?.status,
      },
      error.response?.status || HttpStatus.BAD_REQUEST
    );
    }
  }

   /**
   * Mode MANUAL — utilisé en prod Congo jusqu'à agrément obtenu.
   * Crée un enregistrement PENDING et retourne les instructions de paiement.
   * Le client paie sur le numéro Lilia Food, l'admin confirme manuellement.
   */
  private async createManualPayment(request: CreatePaymentRequest, firebaseUid: string) {
    const order = await this.getPayableOrder(request.orderId, firebaseUid);
    const amount = order.total;
    const currency = 'XAF';

    await this.assertNoPendingPayment(order.id);

    const payment = await this.prisma.payment.create({
      data: {
        orderId: request.orderId,
        amount,
        currency,
        phoneNumber: request.phoneNumber,
        status: 'PENDING',
        provider: 'MANUAL',
        metadata: { mode: 'manual', paymentPhone: this.manualPaymentNumber },
      },
    });

    return {
      paymentId: payment.id,
      mode: 'MANUAL',
      instructions: {
        message: `Envoyez ${amount} FCFA au ${this.manualPaymentNumber} (MTN MoMo)`,
        reference: payment.id.slice(-8).toUpperCase(),
        phone: this.manualPaymentNumber,
        amount,
        note: `Commande ${order.id.slice(-6)} - ${order.restaurant.nom}`,
      },
    };
  }
  /**
   * Confirmation manuelle par l'admin — mode MANUAL uniquement.
   * L'admin vérifie le virement et confirme via cette méthode.
   */
  async confirmManualPayment(paymentId: string) {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: true },
    });

    if (payment.status !== 'PENDING') {
      throw new BadRequestException('Paiement déjà traité');
    }

    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'SUCCESS', updatedAt: new Date() },
    });

    await this.handleSuccessfulPayment(payment);
    return { message: 'Paiement confirmé manuellement' };
  }


  async checkPaymentStatus(paymentId: string, firebaseUid?: string): Promise<PaymentStatus> {
    this.logger.log(`💰 [PAIEMENT] Vérification statut - payment: ${paymentId}`);
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: { include: { restaurant: true } } },
    });

    if (!payment) {
      this.logger.warn(`💰 [PAIEMENT] Échec vérification: payment ${paymentId} introuvable`);
      throw new Error('Payment not found');
    }
    if (firebaseUid) {
      await this.assertPaymentAccess(payment.order.userId, firebaseUid);
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      this.logger.log(`💰 [PAIEMENT] Déjà confirmé: ${paymentId} (commande: ${payment.orderId})`);
      return PaymentStatus.SUCCESS;
    }

    try {
      // Vérifier le statut chez MTN
      this.logger.log(`💰 [PAIEMENT] Interrogation MTN MoMo - ref: ${payment.providerTransactionId}`);
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

      this.logger.log(`💰 [PAIEMENT] Réponse MTN: ${status.status} (actuel: ${payment.status}) - commande: ${payment.orderId}`);

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
          this.logger.log(`💰 [PAIEMENT] ✅ Paiement confirmé - commande: ${payment.orderId}, montant: ${payment.amount} ${payment.currency}`);
          await this.handleSuccessfulPayment(payment);
        } else if (newStatus === PaymentStatus.FAILED) {
          this.logger.warn(`💰 [PAIEMENT] ❌ Paiement échoué - commande: ${payment.orderId}, raison: ${status.reason || 'inconnue'}`);
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
      this.logger.error(`💰 [PAIEMENT] Erreur vérification statut - payment: ${paymentId}, erreur: ${error.message}`, error.stack);
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
    this.logger.warn(`💰 [PAIEMENT] Timeout - payment: ${paymentId}`);
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });

    if (!payment) {
      this.logger.warn(`💰 [PAIEMENT] Timeout ignoré: payment ${paymentId} introuvable`);
      return;
    }

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

  private async getPayableOrder(orderId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurant: true },
    });
    if (!order) throw new NotFoundException('Commande introuvable');
    if (order.userId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException("Vous n'êtes pas autorisé à payer cette commande");
    }
    if (order.status !== OrderStatus.EN_ATTENTE) {
      throw new BadRequestException(`Commande non payable dans le statut actuel: ${order.status}`);
    }
    return order;
  }

  private async assertNoPendingPayment(orderId: string) {
    const existing = await this.prisma.payment.findFirst({
      where: { orderId, status: PaymentStatus.PENDING },
    });
    if (existing) {
      throw new BadRequestException('Un paiement est déjà en attente pour cette commande');
    }
  }

  private async assertPaymentAccess(orderUserId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');
    if (user.role !== 'ADMIN' && user.id !== orderUserId) {
      throw new ForbiddenException('Accès au paiement refusé');
    }
  }
}
