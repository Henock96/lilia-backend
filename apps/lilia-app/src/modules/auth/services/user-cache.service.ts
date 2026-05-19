/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { User } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Cache Redis pour la résolution Firebase UID → User Prisma.
 *
 * Évite un `prisma.user.findUnique` à chaque requête authentifiée
 * (cf. RolesGuard). Gain estimé : -60% charge DB en croisière.
 *
 * Invalidation : appeler `invalidate(firebaseUid)` chaque fois que
 * le User en DB est modifié (role, status, profil, etc.).
 */
@Injectable()
export class UserCacheService {
  private readonly logger = new Logger(UserCacheService.name);
  private readonly TTL_SECONDS = 300; // 5 minutes
  private readonly KEY_PREFIX = 'user:fbuid:';

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Récupère un User par firebaseUid avec cache get-through.
   * Si Redis est indisponible, retombe silencieusement sur Prisma.
   */
  async getByFirebaseUid(firebaseUid: string): Promise<User | null> {
    const key = this.buildKey(firebaseUid);

    try {
      const cached = await this.redis.get(key);
      if (cached) {
        return this.deserialize(cached);
      }
    } catch (err) {
      this.logger.warn(
        `Redis GET échoué (fallback Prisma) : ${(err as Error).message}`,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (user) {
      try {
        await this.redis.setex(key, this.TTL_SECONDS, JSON.stringify(user));
      } catch (err) {
        this.logger.warn(
          `Redis SETEX échoué (cache non rempli) : ${(err as Error).message}`,
        );
      }
    }

    return user;
  }

  /**
   * Invalide l'entrée cache d'un user (à appeler après update/ban/role-change).
   * Idempotent : ne plante pas si la clé n'existe pas.
   */
  async invalidate(firebaseUid: string): Promise<void> {
    if (!firebaseUid) return;
    try {
      await this.redis.del(this.buildKey(firebaseUid));
    } catch (err) {
      this.logger.warn(
        `Redis DEL échoué pour ${firebaseUid} : ${(err as Error).message}`,
      );
    }
  }

  private buildKey(firebaseUid: string): string {
    return `${this.KEY_PREFIX}${firebaseUid}`;
  }

  private deserialize(raw: string): User {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    // Les Date sont sérialisées en strings ISO par JSON.stringify.
    // On les ré-instancie pour préserver le type Prisma User.
    const dateFields = [
      'createdAt',
      'updatedAt',
      'lastLogin',
      'birthDate',
    ] as const;
    for (const field of dateFields) {
      if (obj[field] && typeof obj[field] === 'string') {
        obj[field] = new Date(obj[field] as string);
      }
    }
    return obj as unknown as User;
  }
}
