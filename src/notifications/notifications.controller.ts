import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { RegisterTokenDto } from './dto/register-token.dto';
import { FirebaseAuthGuard } from '../firebase/firebase-auth.guard';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('register-token')
  @UseGuards(FirebaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  async registerToken(@Req() req, @Body() registerTokenDto: RegisterTokenDto) {
    const { uid } = req.user;
    const { token } = registerTokenDto;
    return this.notificationsService.registerToken(uid, token);
  }
}
