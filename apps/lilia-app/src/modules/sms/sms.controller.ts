/* eslint-disable prettier/prettier */
// sms/sms.controller.ts
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SmsService } from './sms.service';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('Admin — SMS')
@ApiBearerAuth()
@Controller('admin/sms')
@Roles('ADMIN')
export class SmsController {
  constructor(private readonly smsService: SmsService) {}

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Envoyer un SMS de test (admin)' })
  sendTest(@Body('to') to: string) {
    return this.smsService.send(
      to,
      'Lilia Food : SMS de test depuis le dashboard admin.',
    );
  }
}