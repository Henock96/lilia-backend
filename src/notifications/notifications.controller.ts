import { Controller, Sse, UseGuards, Req, NotFoundException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map, finalize } from 'rxjs/operators';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { UserService } from 'src/users/users.service';
import { NotificationsService, SseMessage } from './notifications.service';

interface MessageEvent {
  type: string;
  data: string;
}

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly userService: UserService, // Injecter le service utilisateur
  ) {}

  @Sse('sse')
  @UseGuards(FirebaseAuthGuard)
  async sse(@Req() req): Promise<Observable<MessageEvent>> {
    const firebaseUser = req.user;

    // 1. Trouver l'utilisateur dans notre base de données
    const localUser = await this.userService.findUserByFirebaseUid(firebaseUser.uid);
    if (!localUser) {
      throw new NotFoundException("Utilisateur local non trouvé pour ce token.");
    }
    const userId = localUser.id;

    // 2. Obtenir le flux d'événements pour cet utilisateur
    return this.notificationsService.getStreamForUser(userId).pipe(
      // 3. Transformer les données pour le client
      map((message: SseMessage) => ({
        type: message.type,
        data: JSON.stringify(message.data),
      })),
      // 4. Gérer la déconnexion du client
      finalize(() => {
        this.notificationsService.removeStreamForUser(userId);
      }),
    );
  }
}
