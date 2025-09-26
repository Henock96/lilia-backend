import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { FirebaseAuthGuard } from '../firebase/firebase-auth.guard';

@Controller('notifications')
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('register-token')
  @UseGuards(FirebaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  async registerToken(@Request() req: any, @Body('token') token: string) {
    this.logger.log('=== TOKEN REGISTRATION DEBUG ===');
    this.logger.log('Firebase UID from token:', req.user?.uid);
    this.logger.log('User email:', req.user?.email);
    this.logger.log('FCM Token received:', token?.substring(0, 20) + '...');

    if (!req.user?.uid) {
      this.logger.error('Firebase UID not found in decoded token');
      throw new UnauthorizedException('Firebase UID not found');
    }

    if (!token) {
      this.logger.error('FCM token not provided');
      throw new UnauthorizedException('FCM token is required');
    }

    try {
      const result = await this.notificationsService.registerToken(
        req.user.uid, // Utiliser l'UID du token décodé
        token,
      );
      this.logger.log('Token registration result:', result);
      return result;
    } catch (error) {
      this.logger.error('Token registration failed:', error.message);
      throw error;
    }
  }
}
