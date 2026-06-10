/* eslint-disable prettier/prettier */
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
