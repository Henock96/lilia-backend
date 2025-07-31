import { Injectable } from '@nestjs/common';
import { Response } from 'express';

@Injectable()
export class NotificationsService {
  private readonly clients: Map<string, Response> = new Map();

  addClient(userId: string, response: Response) {
    this.clients.set(userId, response);
    response.on('close', () => {
      this.clients.delete(userId);
    });
  }

  sendToUser(
    userId: string,
    data: { type: string; order: any; message?: string },
  ) {
    const client = this.clients.get(userId);
    if (client) {
      // Utiliser des événements nommés pour plus de clarté côté client
      client.write(`event: ${data.type}
`);
      client.write(`data: ${JSON.stringify(data.order)}

`);
    }
  }
}
