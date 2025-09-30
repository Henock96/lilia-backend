/* eslint-disable prettier/prettier */
import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { PaymentService, CreatePaymentRequest } from '../services/payment.service';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard'; 

@Controller('payments')
@UseGuards(FirebaseAuthGuard)
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('create')
  async createPayment(@Body() request: CreatePaymentRequest) {
    return this.paymentService.createPayment(request);
  }

  @Get(':paymentId/status')
  async getPaymentStatus(@Param('paymentId') paymentId: string) {
    const status = await this.paymentService.checkPaymentStatus(paymentId);
    return { paymentId, status };
  }
}