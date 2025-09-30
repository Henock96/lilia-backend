/* eslint-disable prettier/prettier */
import { Controller, Post, Body, Headers, Logger } from '@nestjs/common';
import { PaymentService } from '../services/payment.service';
import { PaymentWebhookPayload } from '../types/mtn-momo.types';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly paymentService: PaymentService, private readonly prisma: PrismaService) {}

  @Post('mtn-momo')
  async handleMtnMomoWebhook(
    @Body() payload: PaymentWebhookPayload,
    @Headers('x-callback-signature') signature: string,
  ) {
    this.logger.log(`Received MTN MoMo webhook: ${signature}, ${JSON.stringify(payload)}`);
    
    // Ici vous pouvez valider la signature du webhook si MTN en fournit une
    
    try {
      // Traiter le webhook selon le statut
      if (payload.status === 'SUCCESSFUL') {
        // Retrouver le paiement via la référence
        const payment = await this.prisma.payment.findFirst({
          where: { providerTransactionId: payload.referenceId },
        });

        if (payment) {
          await this.paymentService.checkPaymentStatus(payment.id);
        }
      }

      return { status: 'success' };
    } catch (error) {
      this.logger.error(`Webhook processing failed: ${error.message}`);
      return { status: 'error', message: error.message };
    }
  }
}
