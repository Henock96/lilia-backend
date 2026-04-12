import {
  Controller,
  Post,
  Delete,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DecodedIdToken } from 'firebase-admin/auth';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Enregistre le token FCM du device au login.
   * Appelé par l'app mobile juste après connexion.
   */
  @Post('register-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enregistrer un token FCM (login device)' })
  async registerToken(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Body('token') token: string,
  ) {
    return this.notificationsService.registerToken(fbUser.uid, token);
  }
  /**
   * Supprime le token FCM au logout.
   * Empêche de recevoir des notifs sur un device déconnecté.
   */
  @Delete('token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer le token FCM (logout device)' })
  removeToken(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Body('token') token: string,
  ) {
    return this.notificationsService.removeToken(fbUser.uid, token);
  }
}
