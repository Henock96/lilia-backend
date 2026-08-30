// adapters/redis-io.adapter.ts
import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';

/**
 * Remplace l'adapter Socket.io par défaut par un adapter Redis.
 * Permet à plusieurs instances NestJS de partager les rooms WebSocket.
 * Un livreur connecté à l'instance A peut broadcaster au client
 * connecté à l'instance B — transparent pour Flutter.
 *
 * Fix L2 (audit du 28/08/2026) : cet adapter utilisait `redis` (node-redis)
 * alors que tout le reste de l'application utilise `ioredis` — deux clients,
 * deux pools de connexions, deux comportements de reconnexion à connaître.
 * `@socket.io/redis-adapter` accepte les deux ; on garde `ioredis`, celui du
 * `RedisModule`, et la dépendance `redis` a été retirée du `package.json`.
 */
export class RedisIoAdapter extends IoAdapter {
  private static readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  async connectToRedis(redisUrl: string): Promise<void> {
    // Deux connexions Redis : une pour publish, une pour subscribe.
    // C'est une contrainte du protocole Redis Pub/Sub.
    const pubClient = new Redis(redisUrl, { lazyConnect: true });
    const subClient = pubClient.duplicate();

    // Sans handler 'error', une erreur de socket Redis remonte en exception
    // non gérée et tue le process (déjà corrigé ailleurs — audit d'août).
    for (const client of [pubClient, subClient]) {
      client.on('error', (err) =>
        RedisIoAdapter.logger.error(
          `Redis (adapter WebSocket) : ${err.message}`,
        ),
      );
    }

    await Promise.all([pubClient.connect(), subClient.connect()]);
    this.clients = [pubClient, subClient];

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }

  /** Ferme proprement les connexions à l'arrêt (SIGTERM → shutdown hooks). */
  async close(server: unknown): Promise<void> {
    await Promise.allSettled(this.clients.map((client) => client.quit()));
    return super.close(server as never);
  }
}
