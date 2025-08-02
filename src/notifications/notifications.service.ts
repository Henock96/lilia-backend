import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';

export interface SseMessage {
  type: 'order_update' | 'new_order';
  data: any;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  // Map pour stocker un flux d'événements pour chaque utilisateur (clé = ID utilisateur interne)
  private readonly userEventStreams = new Map<string, Subject<SseMessage>>();

  /**
   * Crée ou récupère le flux d'événements pour un utilisateur spécifique.
   * @param userId L'ID interne de l'utilisateur.
   * @returns Un Observable auquel le contrôleur peut s'abonner.
   */
  getStreamForUser(userId: string): Observable<SseMessage> {
    this.logger.log(
      `Création ou récupération du flux pour l'utilisateur: ${userId}`,
    );
    if (!this.userEventStreams.has(userId)) {
      this.userEventStreams.set(userId, new Subject<SseMessage>());
    }
    return this.userEventStreams.get(userId).asObservable();
  }

  /**
   * Envoie un événement à un utilisateur spécifique.
   * @param userId L'ID interne de l'utilisateur à notifier.
   * @param event L'événement à envoyer.
   */
  sendEventToUser(userId: string, event: SseMessage) {
    const userStream = this.userEventStreams.get(userId);
    if (userStream) {
      this.logger.log(
        `Envoi de l'événement de type ${event.type} à l'utilisateur: ${userId}`,
      );
      userStream.next(event);
    } else {
      this.logger.warn(
        `Tentative d'envoi à un utilisateur non connecté au SSE: ${userId}`,
      );
    }
  }

  /**
   * Nettoie et ferme le flux pour un utilisateur déconnecté.
   * @param userId L'ID interne de l'utilisateur.
   */
  removeStreamForUser(userId: string) {
    const userStream = this.userEventStreams.get(userId);
    if (userStream) {
      this.logger.log(`Fermeture du flux pour l'utilisateur: ${userId}`);
      userStream.complete();
      this.userEventStreams.delete(userId);
    }
  }
}
