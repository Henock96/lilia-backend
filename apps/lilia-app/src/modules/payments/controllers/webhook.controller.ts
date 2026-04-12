/* eslint-disable prettier/prettier */
import { Controller, Post, Body, Headers, Logger, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentService } from '../services/payment.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { Public } from '../../auth/decorators/public.decorator';

interface MtnWebhookPayload {
  referenceId: string;
  status: 'SUCCESSFUL' | 'FAILED' | 'PENDING';
  financialTransactionId?: string;
}

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly paymentService: PaymentService, private readonly prisma: PrismaService) {}

  /**
   * Reçoit les callbacks MTN MoMo.
   * @Public() — pas d'auth Firebase (MTN appelle directement ce endpoint).
   * En production, valider la signature dans les headers.
   */
  @Public()
  @Post('mtn-momo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Callback MTN MoMo (webhook)' })
  async handleMtnMomoWebhook(
    @Body() payload: MtnWebhookPayload,
    @Headers('x-callback-signature') signature?: string,
  ) {
    this.logger.log(`Webhook MTN reçu : ${payload.referenceId} → ${payload.status}`);

    try {
      if (payload.status === 'SUCCESSFUL') {
        const payment = await this.prisma.payment.findFirst({
          where: { providerTransactionId: payload.referenceId },
        });

        if (payment) {
          await this.paymentService.checkPaymentStatus(payment.id);
          this.logger.log(`Paiement ${payment.id} traité via webhook`);
        } else {
          this.logger.warn(`Webhook : aucun paiement trouvé pour ref ${payload.referenceId}`);
        }
      }

      return { status: 'received' };
    } catch (error) {
      this.logger.error(`Webhook MTN échoué : ${error.message}`);
      // On retourne 200 quand même pour éviter que MTN retry en boucle
      return { status: 'error', message: error.message };
    }
  }
}
