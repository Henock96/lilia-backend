import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
  ThrottlerException,
} from '@nestjs/throttler';
import {
  THROTTLER_BLOCK_DURATION,
  THROTTLER_KEY_GENERATOR,
  THROTTLER_LIMIT,
  THROTTLER_SKIP,
  THROTTLER_TRACKER,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import * as Sentry from '@sentry/nestjs';

/**
 * `ThrottlerGuard` dont les limiteurs s'exécutent **en parallèle**.
 *
 * ## Le problème
 *
 * `canActivate` de `@nestjs/throttler` parcourt les limiteurs avec un `await`
 * **dans la boucle** :
 *
 * ```js
 * for (const namedThrottler of this.throttlers) {
 *   continues.push(await this.handleRequest({ … }));
 * }
 * ```
 *
 * Nous en déclarons deux (`short` 10/s, `long` 100/min) et
 * `@nest-lab/throttler-storage-redis` fait **un `EVAL` par limiteur**. Avec un
 * Redis à ~271 ms de l'instance, cela fait **deux allers-retours en série sur
 * chaque requête**, soit ~545 ms payés avant même d'atteindre
 * `FirebaseAuthGuard` — mesuré côté serveur (Sentry, `span.op:middleware.nestjs`,
 * p50 sur 7 680 requêtes) et confirmé côté client.
 *
 * Les deux `EVAL` portent sur des clés **disjointes** (la clé est suffixée du
 * nom du limiteur) : rien n'oblige à les enchaîner. En parallèle, ioredis les
 * écrit d'affilée sur la socket et les deux réponses reviennent ensemble —
 * **2 allers-retours deviennent 1**.
 *
 * ## Ce qui n'est pas touché
 *
 * · les deux limites métier (`short` 10/s **et** `long` 100/min) sont
 *   conservées, aucune n'est supprimée ni relâchée ;
 * · les **17 décorateurs `@Throttle`** du dépôt continuent d'être lus, limiteur
 *   par limiteur, exactement comme avant ;
 * · `@SkipThrottle(SKIP_ALL_THROTTLERS)` sur `/health*` continue d'exempter.
 *
 * ## ⚠️ La différence de comportement, assumée
 *
 * En série, un rejet de `short` interrompt la boucle : `long` n'est jamais
 * incrémenté. En parallèle, les deux compteurs avancent. Un client bloqué par
 * la limite à la seconde consomme donc aussi son quota à la minute.
 *
 * C'est **plus strict**, jamais plus permissif — un client qui respecte les
 * limites ne voit aucune différence, un client qui les dépasse est freiné un
 * peu plus tôt. Le message d'erreur reste celui du **premier** limiteur dans
 * l'ordre de tri de la bibliothèque (`ttl` croissant, donc `short` d'abord),
 * ce qui le garde déterministe.
 *
 * ## ⚠️ Dégradation si Redis est indisponible
 *
 * Aujourd'hui, une erreur du stockage remonte de `handleRequest` jusqu'à
 * `canActivate` sans être rattrapée : une panne Redis fait répondre **500 à
 * toutes les requêtes**, y compris publiques. On laisse désormais passer la
 * requête en alertant Sentry.
 *
 * C'est un arbitrage de sécurité explicite, et c'est le même que celui déjà
 * assumé ailleurs dans ce dépôt : `OrderCheckoutService` continue sans garde
 * d'idempotence quand Redis tombe, en alertant, plutôt que de refuser les
 * commandes. Le rate limiting est une **protection**, pas une garantie de
 * correction : rendre la plateforme inutilisable pour la préserver serait une
 * plus grande panne que celle qu'on subit.
 *
 * ---
 * Cette classe recopie la résolution d'options de `@nestjs/throttler@6.4.0`.
 * Les tests de `parallel-throttler.guard.spec.ts` portent sur le
 * **comportement** (les deux limites s'appliquent, les décorateurs sont
 * honorés) : ils échoueront si une montée de version change ce contrat.
 */
@Injectable()
export class ParallelThrottlerGuard extends ThrottlerGuard {
  private readonly degradationLogger = new Logger(ParallelThrottlerGuard.name);

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (await this.shouldSkip(context)) return true;

    const handler = context.getHandler();
    const classRef = context.getClass();

    // Phase 1 — résolution des options, identique à la version d'origine.
    // Elle est synchrone hormis `resolveValue`, et surtout ne touche pas Redis :
    // c'est la phase 2 qui coûte, et c'est elle qu'on parallélise.
    const planned = await Promise.all(
      this.throttlers.map(async (namedThrottler) => {
        const skip = this.reflector.getAllAndOverride<boolean>(
          THROTTLER_SKIP + namedThrottler.name,
          [handler, classRef],
        );
        const skipIf = namedThrottler.skipIf ?? this.commonOptions.skipIf;
        if (skip || skipIf?.(context)) return null;

        const routeOrClassLimit = this.reflector.getAllAndOverride(
          THROTTLER_LIMIT + namedThrottler.name,
          [handler, classRef],
        );
        const routeOrClassTtl = this.reflector.getAllAndOverride(
          THROTTLER_TTL + namedThrottler.name,
          [handler, classRef],
        );
        const routeOrClassBlockDuration = this.reflector.getAllAndOverride(
          THROTTLER_BLOCK_DURATION + namedThrottler.name,
          [handler, classRef],
        );
        const routeOrClassGetTracker = this.reflector.getAllAndOverride(
          THROTTLER_TRACKER + namedThrottler.name,
          [handler, classRef],
        );
        const routeOrClassGetKeyGenerator = this.reflector.getAllAndOverride(
          THROTTLER_KEY_GENERATOR + namedThrottler.name,
          [handler, classRef],
        );

        const limit = await this.resolve(
          context,
          routeOrClassLimit || namedThrottler.limit,
        );
        const ttl = await this.resolve(
          context,
          routeOrClassTtl || namedThrottler.ttl,
        );
        const blockDuration = await this.resolve(
          context,
          routeOrClassBlockDuration || namedThrottler.blockDuration || ttl,
        );

        return {
          context,
          limit,
          ttl,
          throttler: namedThrottler,
          blockDuration,
          getTracker:
            routeOrClassGetTracker ??
            namedThrottler.getTracker ??
            this.commonOptions.getTracker!,
          generateKey:
            routeOrClassGetKeyGenerator ??
            namedThrottler.generateKey ??
            this.commonOptions.generateKey!,
        };
      }),
    );

    // Phase 2 — LE changement : un aller-retour Redis par limiteur, tous
    // ensemble. `allSettled` et non `all` : les deux doivent partir, et on veut
    // choisir nous-mêmes quelle erreur remonte.
    const outcomes = await Promise.allSettled(
      planned.map((props) =>
        props ? this.handleRequest(props) : Promise.resolve(true),
      ),
    );

    // `this.throttlers` est trié par `ttl` croissant à l'initialisation :
    // parcourir dans cet ordre rend le message d'erreur déterministe, et c'est
    // le même que celui que produisait la boucle séquentielle.
    for (const outcome of outcomes) {
      if (outcome.status !== 'rejected') continue;
      if (outcome.reason instanceof ThrottlerException) throw outcome.reason;
      // Le stockage est tombé (timeout, panne). Voir l'en-tête : on passe.
      this.reportDegradation(outcome.reason);
    }

    return true;
  }

  private reportDegradation(reason: unknown): void {
    const message =
      reason instanceof Error ? reason.message : String(reason ?? 'inconnue');
    this.degradationLogger.error(
      `Rate limiting indisponible — requête laissée passer sans compteur : ${message}`,
    );
    Sentry.captureException(reason, {
      tags: { feature: 'rate-limiting', degraded: 'true' },
    });
  }

  /** `resolveValue` de la classe parente est privée : on la réimplémente. */
  private async resolve<T>(
    context: ExecutionContext,
    value: T | ((ctx: ExecutionContext) => T | Promise<T>),
  ): Promise<T> {
    return typeof value === 'function'
      ? await (value as (ctx: ExecutionContext) => T | Promise<T>)(context)
      : value;
  }
}
