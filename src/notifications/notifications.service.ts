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

  sendToUser(userId: string, data: any) {
    const client = this.clients.get(userId);
    if (client) {
      client.write(`data: ${JSON.stringify(data)}

`);
    }
  }
}
