/* eslint-disable prettier/prettier */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
  StreamableFile,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Clé de métadonnée pour `@SkipResponseWrap()`.
 * Exportée pour les tests / cas avancés.
 */
export const SKIP_RESPONSE_WRAP_KEY = 'skipResponseWrap';

/**
 * Clés de pagination « legacy » repliées automatiquement sous `meta` par
 * l'intercepteur (règle 3b) afin de produire le contrat conforme
 * `{ data, meta }` plutôt qu'un double-wrap `{ data: { data, total, ... } }`.
 */
const PAGINATION_KEYS = [
  'total',
  'page',
  'limit',
  'count',
  'totalPages',
  'offset',
  'hasMore',
];

/**
 * Décorateur permettant à un endpoint (ou un controller entier) de bypasser
 * l'enveloppe `{ data, message?, meta? }` ajoutée par `ApiResponseInterceptor`.
 *
 * À utiliser pour :
 * - Webhooks externes (MTN MoMo, Airtel) — passthrough natif attendu
 * - Endpoints qui renvoient un binaire / stream (StreamableFile est déjà
 *   géré automatiquement, mais c'est ceinture+bretelles)
 * - Tout endpoint dont le contrat de réponse a déjà été figé côté client
 *   et qu'on ne peut pas migrer sur-le-champ
 *
 * Usage :
 * ```ts
 * @SkipResponseWrap()
 * @Post('mtn-momo')
 * handleWebhook() { return { status: 'received' }; }
 * ```
 *
 * Peut être posé au niveau classe ou méthode (la méthode prime).
 */
export const SkipResponseWrap = () => SetMetadata(SKIP_RESPONSE_WRAP_KEY, true);

/**
 * Intercepteur GLOBAL d'uniformisation des réponses API.
 *
 * Contrat de réponse (J2 — API Contract v2) :
 * ```json
 * { "data": <payload>, "message"?: string, "meta"?: object }
 * ```
 *
 * Règles :
 * 1. `undefined` / `null` → `{ data: null }`
 * 2. `StreamableFile` ou réponses marquées `@SkipResponseWrap()` → passthrough brut
 * 3. Objet possédant déjà une clé `data` (et seulement des clés autorisées :
 *    `data`, `message`, `meta`) → passthrough — déjà conforme
 * 4. Sinon → `{ data: response }`
 *
 * ⚠️ Les `HttpException` sont gérées en aval par `HttpExceptionFilter` qui
 * produit déjà le shape `APIResponse` legacy `{ success, data, error, message,
 * statusCode }`. L'intercepteur n'est jamais déclenché sur le chemin d'erreur.
 *
 * Pagination (règle 3b) : les endpoints renvoyant `{ data, total, page, limit }`
 * ou `{ data, count }` sont normalisés en `{ data, meta: { total, page, limit,
 * totalPages } }` (contrat conforme), au lieu d'être double-wrappés. Les clients
 * (Flutter ×2 / Next.js) lisent la liste dans `data` et la pagination dans `meta`.
 */
@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Hors HTTP (WebSocket, RPC, micro-services) : on ne touche pas.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_RESPONSE_WRAP_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skip) {
      return next.handle();
    }

    return next.handle().pipe(
      map((response: unknown) => {
        // 1. null / undefined
        if (response === undefined || response === null) {
          return { data: null };
        }

        // 2. Streams binaires — jamais wrappés
        if (response instanceof StreamableFile) {
          return response;
        }

        // 3. Déjà enveloppé au bon format ?
        if (
          typeof response === 'object' &&
          !Array.isArray(response) &&
          'data' in response &&
          Object.keys(response as Record<string, unknown>).every((k) =>
            ['data', 'message', 'meta'].includes(k),
          )
        ) {
          return response;
        }

        // 3b. Réponse paginée « legacy » `{ data, total?, page?, limit?, count? }` :
        // on replie les clés de pagination sous `meta` pour produire le contrat
        // conforme `{ data, meta }` (API Contract v2) — au lieu d'un double-wrap.
        // Ne s'applique que si TOUTES les clés hors data/message/meta sont des
        // clés de pagination connues (sinon c'est un objet métier → wrap normal).
        if (
          typeof response === 'object' &&
          !Array.isArray(response) &&
          'data' in response
        ) {
          const rec = response as Record<string, unknown>;
          const extraKeys = Object.keys(rec).filter(
            (k) => k !== 'data' && k !== 'message' && k !== 'meta',
          );
          if (
            extraKeys.length > 0 &&
            extraKeys.every((k) => PAGINATION_KEYS.includes(k))
          ) {
            const meta: Record<string, unknown> = {
              ...(rec.meta && typeof rec.meta === 'object'
                ? (rec.meta as Record<string, unknown>)
                : {}),
            };
            for (const k of extraKeys) meta[k] = rec[k];
            // `totalPages` dérivé si absent et calculable.
            if (
              meta.totalPages === undefined &&
              typeof meta.total === 'number' &&
              typeof meta.limit === 'number' &&
              meta.limit > 0
            ) {
              meta.totalPages = Math.max(
                1,
                Math.ceil(meta.total / meta.limit),
              );
            }
            const out: Record<string, unknown> = { data: rec.data, meta };
            if (typeof rec.message === 'string') out.message = rec.message;
            return out;
          }
        }

        // 4. Fallback : on enveloppe
        return { data: response };
      }),
    );
  }
}
