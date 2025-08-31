import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Get,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { RegisterTokenDto } from './dto/register-token.dto';
import { FirebaseAuthGuard } from '../firebase/firebase-auth.guard';
import { Observable } from 'rxjs';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('sse')
  @UseGuards(FirebaseAuthGuard)
  sse(@Req() req): Observable<MessageEvent> {
    const { user } = req;
    const subject = this.notificationsService.addSseClient(user.id);

    req.on('close', () => {
      this.notificationsService.removeSseClient(user.id);
    });

    return new Observable((observer) => {
      subject.subscribe({
        next: (msg) => {
          observer.next({ data: msg });
        },
        error: (err) => observer.error(err),
        complete: () => observer.complete(),
      });
    });
  }

  @Post('register-token')
  @UseGuards(FirebaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  async registerToken(@Req() req, @Body() registerTokenDto: RegisterTokenDto) {
    const { uid } = req.user;
    const { token } = registerTokenDto;
    return this.notificationsService.registerToken(uid, token);
  }
}
