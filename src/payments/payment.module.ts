/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MtnMomoService } from './services/mtn-momo.service';
import { PaymentService } from './services/payment.service';
import { PaymentController } from './controllers/payment.controller';
import { WebhookController } from './controllers/webhook.controller'; 
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [PaymentController, WebhookController],
  providers: [MtnMomoService, PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {
  constructor(private readonly mtnMomoService: MtnMomoService) {}

  /*async onModuleInit() {
    await this.mtnMomoService.initialize();
  }*/
}