// adapters/redis-io.adapter.ts
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { INestApplication } from '@nestjs/common';

/**
 * Remplace l'adapter Socket.io par défaut par un adapter Redis.
 * Permet à plusieurs instances NestJS de partager les rooms WebSocket.
 * Un livreur connecté à l'instance A peut broadcaster au client
 * connecté à l'instance B — transparent pour Flutter.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;

  async connectToRedis(redisUrl: string): Promise<void> {
    // Deux connexions Redis : une pour publish, une pour subscribe
    // C'est une contrainte du protocole Redis Pub/Sub
    const pubClient = createClient({ url: redisUrl });
    const subClient = pubClient.duplicate();

    await Promise.all([pubClient.connect(), subClient.connect()]);

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}