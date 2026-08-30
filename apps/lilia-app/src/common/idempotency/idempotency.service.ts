import {
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import * as Sentry from '@sentry/nestjs';

/**
 * Réservation atomique d'une clé d'idempotence, partagée par les opérations
 * qui ne doivent pas s'exécuter deux fois.
 *
 * Généralisation du mécanisme éprouvé sur `POST /orders/checkout` : la clé est
 * posée en `SET NX` **avant** tout traitement, pas après. L'implémentation
 * naïve — lire, puis écrire à la fin — laisse précisément passer le cas qu'elle
 * prétend couvrir : deux requêtes concurrentes lisent toutes deux « absente »
 * et créent chacune leur exemplaire.
 *
 * `OrderCheckoutService` conserve sa propre copie, volontairement : le checkout
 * est le chemin le plus critique et le mieux testé du système, le migrer sans
 * nécessité fonctionnelle ferait courir un risque sans contrepartie.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private static readonly PENDING = '__pending__';
  /** Durée pendant laquelle un traitement en cours bloque ses concurrents. */
  private static readonly PENDING_TTL_SECONDS = 120;
  /** Durée pendant laquelle un retry légitime rejoue la réponse d'origine. */
  private static readonly RESULT_TTL_SECONDS = 3600;

  // `@Optional` : en développement local sans `REDIS_URL`, le client n'est pas
  // fourni. En production il est requis au démarrage (fix M11), donc ce cas ne
  // se présente pas là où la garde compte vraiment.
  constructor(@Optional() @InjectRedis() private readonly redis?: Redis) {}

  /**
   * Exécute `operation` au plus une fois pour un `scope` et une `key` donnés.
   *
   * - premier appel → exécute, mémorise la réponse ;
   * - retry après succès → rejoue la réponse mémorisée, sans réexécuter ;
   * - appel concurrent pendant le traitement → 409 ;
   * - Redis indisponible → exécute sans garde, et le signale (une garde
   *   silencieusement inactive est pire qu'une garde absente).
   */
  async runOnce<T>(
    scope: string,
    key: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const trimmed = key?.trim();
    if (!trimmed || !this.redis) {
      if (!this.redis) this.warnDegraded(scope);
      return operation();
    }

    const cacheKey = `idempotency:${scope}:${trimmed}`;
    const claim = await this.claim(cacheKey, scope);

    if (!claim.reserved && claim.replay !== undefined) {
      this.logger.log(`[IDEMPOTENCY] ${scope} — réponse rejouée`);
      return claim.replay as T;
    }

    try {
      const result = await operation();
      if (claim.reserved) await this.store(cacheKey, result);
      return result;
    } catch (err) {
      // L'échec libère la clé : un vrai retry doit rester possible. Sans ça,
      // une erreur transitoire condamnerait la clé pendant deux minutes.
      if (claim.reserved) await this.redis.del(cacheKey).catch(() => undefined);
      throw err;
    }
  }

  private async claim(
    cacheKey: string,
    scope: string,
  ): Promise<{ reserved: boolean; replay?: unknown }> {
    try {
      const reserved = await this.redis!.set(
        cacheKey,
        IdempotencyService.PENDING,
        'EX',
        IdempotencyService.PENDING_TTL_SECONDS,
        'NX',
      );
      if (reserved === 'OK') return { reserved: true };

      const existing = await this.redis!.get(cacheKey);

      // Expirée entre le SET et le GET : une seule nouvelle tentative.
      if (existing === null) {
        const retry = await this.redis!.set(
          cacheKey,
          IdempotencyService.PENDING,
          'EX',
          IdempotencyService.PENDING_TTL_SECONDS,
          'NX',
        );
        if (retry === 'OK') return { reserved: true };
        throw new ConflictException(
          'Une opération identique est déjà en cours de traitement.',
        );
      }

      if (existing === IdempotencyService.PENDING) {
        throw new ConflictException(
          'Une opération identique est déjà en cours de traitement.',
        );
      }

      return { reserved: false, replay: JSON.parse(existing) };
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      this.warnDegraded(scope, err as Error);
      return { reserved: false };
    }
  }

  private async store(cacheKey: string, result: unknown): Promise<void> {
    await this.redis!.setex(
      cacheKey,
      IdempotencyService.RESULT_TTL_SECONDS,
      JSON.stringify(result),
    ).catch((err: Error) =>
      this.logger.error(`[IDEMPOTENCY] Mémorisation échouée : ${err.message}`),
    );
  }

  private warnDegraded(scope: string, err?: Error): void {
    this.logger.error(
      `[IDEMPOTENCY] Redis indisponible — ${scope} exécuté sans garde${
        err ? ` : ${err.message}` : ''
      }`,
    );
    Sentry.captureMessage(`Idempotence dégradée sur ${scope}`, {
      level: 'warning',
      tags: { feature: 'idempotency', scope, degraded: 'true' },
    });
  }
}
