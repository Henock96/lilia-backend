import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { SentryExceptionCaptured } from '@sentry/nestjs';
import { Response } from 'express';
import { APIResponse } from '../types/APIResponse';
import { mapPrismaError } from './prisma-error.mapper';

/**
 * ⚠️ Une traduction des erreurs multer a été écrite ici puis **retirée**.
 *
 * Elle était inatteignable : `@nestjs/platform-express` fait passer chaque
 * erreur multer par `transformException()` **à l'intérieur** de
 * `FileInterceptor` (`multer/multer/multer.utils.js`), qui convertit
 * `LIMIT_FILE_SIZE` en `PayloadTooLargeException` et `LIMIT_FILE_COUNT` /
 * `LIMIT_UNEXPECTED_FILE` en `BadRequestException` avant que l'erreur ne quitte
 * l'intercepteur. Une `MulterError` n'arrive donc jamais jusqu'ici : elle est
 * déjà une `HttpException`, traitée par la branche du dessus.
 *
 * Conséquence assumée : sur un envoi hors limite, le client reçoit le libellé
 * **anglais** de multer (« File too large », « Too many files ») plutôt qu'un
 * message français. Le code HTTP, lui, est juste — 413 et 400 — et c'est ce qui
 * comptait : un 5xx aurait déclenché le rejeu automatique des applications
 * Flutter, et le même fichier serait reparti trois fois.
 *
 * Traduire ces messages supposerait de filtrer sur les chaînes d'une
 * dépendance, qui peuvent changer sans préavis. À faire, si on le fait, là où
 * elles sont produites — pas ici, où elles ne passent pas.
 */

/**
 * Statut HTTP porté par une erreur qui n'est pas une `HttpException`.
 *
 * ## `expose: true` est exigé, et ce n'est pas un détail
 *
 * Beaucoup d'erreurs portent un `status` qui ne nous appartient pas.
 * `AxiosError` porte celui de la réponse **amont** : une clé Infobip révoquée
 * lève une erreur à `status: 401`. La recopier ferait répondre 401 à *notre*
 * client — et `ErrorInterceptor`, identique dans les deux applications Flutter,
 * traduit 401 en `ApiErrorKind.unauthorized`, c'est-à-dire en fin de session.
 * Une panne de configuration SMS déconnecterait les utilisateurs.
 *
 * On n'accorde donc le statut qu'aux erreurs qui **déclarent** être exposables,
 * via la convention `expose` d'`http-errors` — que suit `body-parser`, le cas
 * réel qui motive tout ce chemin (`PayloadTooLargeError`, `status: 413`,
 * `expose: true`). Tout le reste reste un 500 générique.
 *
 * La borne de plage évite par ailleurs un `res.status(42)`, qui ferait lever
 * Express.
 */
function statusCarriedBy(
  exception: unknown,
): { status: number; message: string } | null {
  if (!exception || typeof exception !== 'object') return null;

  const err = exception as {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
    message?: unknown;
  };
  // Le contrat est déclaratif : sans `expose`, le statut n'est pas le nôtre.
  if (err.expose !== true) return null;

  const raw = typeof err.status === 'number' ? err.status : err.statusCode;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < 400 || raw > 599) return null;

  const message =
    typeof err.message === 'string' && err.message
      ? err.message
      : 'Erreur interne du serveur';

  return { status: raw, message };
}

/**
 * Filtre d'exception GLOBAL (catch-all).
 *
 * - HttpException : formaté en APIResponse avec le statut d'origine.
 * - Toute autre erreur (bug non géré) : 500 + message générique (on ne fuite
 *   pas le détail interne au client).
 *
 * `@SentryExceptionCaptured()` remonte chaque exception à Sentry. Les 4xx
 * (erreurs attendues) sont filtrées en amont par `beforeSend` dans instrument.ts.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  @SentryExceptionCaptured()
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();

      // getResponse() peut être :
      //  - une string  → `new HttpException('msg', status)`
      //  - un objet     → exceptions standard Nest : { message, error, statusCode }
      // On ne MUTE jamais l'objet d'origine et on gère les deux formes.
      let message: string | string[];
      let error: unknown = null;

      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object') {
        const obj = res as Record<string, unknown>;
        message =
          (obj.message as string | string[]) ??
          exception.message ??
          'Erreur interne du serveur';
        // `error` = le reste du payload SANS le message (déjà porté par `message`)
        const { message: _omitted, ...rest } = obj;
        error = Object.keys(rest).length > 0 ? rest : null;
      } else {
        message = exception.message || 'Erreur interne du serveur';
      }

      const body: APIResponse = {
        success: false,
        message,
        data: null,
        error,
        statusCode: status,
      };

      response.status(status).json(body);
      return;
    }

    // Erreurs Prisma : une violation de contrainte est une erreur métier, pas
    // un bug. On la traduit en 409/404/400 avec un message actionnable plutôt
    // que de la laisser tomber dans le 500 générique ci-dessous.
    const prismaError = mapPrismaError(exception);
    if (prismaError) {
      this.logger.warn(
        `Erreur Prisma traduite (${(exception as { code?: string }).code ?? 'validation'}) : ${prismaError.message}`,
      );
      response.status(prismaError.status).json({
        success: false,
        message: prismaError.message,
        data: null,
        error: null,
        statusCode: prismaError.status,
      } satisfies APIResponse);
      return;
    }

    // Erreurs qui PORTENT déjà leur statut sans descendre de `HttpException`.
    //
    // `body-parser` en est le cas réel : au-delà de la limite de corps il lève
    // un `PayloadTooLargeError` avec `status: 413`, `expose: true` — mais c'est
    // une `Error` ordinaire, donc elle tombait dans le 500 générique ci-dessous.
    //
    // Trois conséquences, dont la troisième est la vraie (mesurées le
    // 22/09/2026 sur `POST /users/sync` avec 2 Mo) :
    //   1. le client ne peut pas distinguer « ton envoi est trop gros » d'une
    //      panne serveur ;
    //   2. `@SentryExceptionCaptured()` remonte une erreur de client comme une
    //      exception non gérée, et noie l'alerting ;
    //   3. `RetryInterceptor`, identique dans les deux applications Flutter,
    //      **rejoue les 5xx** : le même corps surdimensionné repartait trois
    //      fois avec backoff. Sur la 4G de Brazzaville, une erreur de
    //      validation devenait une tempête d'envois.
    //
    // On ne recopie le statut que s'il est un code HTTP plausible : une
    // propriété `status` peut valoir n'importe quoi sur une erreur tierce, et
    // la passer telle quelle à `res.status()` ferait lever Express.
    const carried = statusCarriedBy(exception);
    if (carried) {
      this.logger.warn(
        `Erreur portant un statut (${carried.status}) : ${carried.message}`,
      );
      response.status(carried.status).json({
        success: false,
        message: carried.message,
        data: null,
        error: null,
        statusCode: carried.status,
      } satisfies APIResponse);
      return;
    }

    // Erreur non gérée = bug. On log côté serveur, on renvoie un 500 générique.
    this.logger.error(
      `Exception non gérée : ${(exception as Error)?.message ?? exception}`,
      (exception as Error)?.stack,
    );

    const body: APIResponse = {
      success: false,
      message: 'Erreur interne du serveur',
      data: null,
      error: null,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    };

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }
}
