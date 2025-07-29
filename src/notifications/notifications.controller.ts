import { Controller, Sse, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Sse('sse')
  @UseGuards(FirebaseAuthGuard)
  sse(@Req() req, @Res() res: Response): void {
    const userId = req.user.uid; // Extrait de FirebaseAuthGuard
    this.notificationsService.addClient(userId, res);

    // Envoyer un message initial pour confirmer la connexion
    res.write(`data: ${JSON.stringify({ message: 'Connection established' })}\n\n`);
  }
}
