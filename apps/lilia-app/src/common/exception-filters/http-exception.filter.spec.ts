import {
  ArgumentsHost,
  BadRequestException,
  PayloadTooLargeException,
} from '@nestjs/common';

import { HttpExceptionFilter } from './http-exception.filter';

/**
 * Le filtre catch-all est le seul endroit où une erreur devient un code HTTP.
 *
 * ⚠️ Il n'attrapait que `HttpException` et les erreurs Prisma. Tout le reste
 * tombait dans le 500 générique — y compris les erreurs de `body-parser`, qui
 * **portent** déjà leur statut mais ne descendent pas de `HttpException`.
 * Conséquence mesurée le 22/09/2026 : un corps de 2 Mo sur `POST /users/sync`
 * répondait 500, et le `RetryInterceptor` des deux applications Flutter, qui
 * rejoue les 5xx, renvoyait le même corps trois fois.
 */
describe('HttpExceptionFilter', () => {
  function makeHost() {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    return { host, status, json };
  }

  /** L'erreur exacte que `body-parser` lève au-delà de la limite de corps. */
  function payloadTooLargeError() {
    const err = new Error('request entity too large') as Error & {
      status: number;
      statusCode: number;
      type: string;
      expose: boolean;
    };
    err.status = 413;
    err.statusCode = 413;
    err.type = 'entity.too.large';
    err.expose = true;
    return err;
  }

  it('rend 413 sur un corps de requête trop volumineux', () => {
    const { host, status, json } = makeHost();

    new HttpExceptionFilter().catch(payloadTooLargeError(), host);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, statusCode: 413 }),
    );
  });

  it('ne laisse pas un corps trop volumineux passer pour une panne serveur', () => {
    const { host, status } = makeHost();

    new HttpExceptionFilter().catch(payloadTooLargeError(), host);

    // C'est CE point qui compte : un 5xx déclenche le rejeu automatique côté
    // client. Une erreur d'envoi ne doit jamais ressembler à une panne.
    expect(status).not.toHaveBeenCalledWith(500);
  });

  it('conserve le message d’un statut porté, sans exposer la pile', () => {
    const { host, json } = makeHost();

    new HttpExceptionFilter().catch(payloadTooLargeError(), host);

    const body = json.mock.calls[0][0] as { message: string; error: unknown };
    expect(body.message).toBe('request entity too large');
    expect(body.error).toBeNull();
  });

  /**
   * Ce que reçoit réellement le client sur un envoi hors limite.
   *
   * ⚠️ `FileInterceptor` convertit déjà `MulterError` en `PayloadTooLargeException`
   * (cf. l'en-tête du filtre) : le message est celui de multer, en anglais.
   * Ce test le fige pour que la chose soit vue et non découverte en production.
   */
  it('rend le 413 de multer tel que Nest l’a déjà transformé', () => {
    const { host, status, json } = makeHost();

    new HttpExceptionFilter().catch(
      new PayloadTooLargeException('File too large'),
      host,
    );

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'File too large', statusCode: 413 }),
    );
  });

  it('laisse les HttpException inchangées', () => {
    const { host, status, json } = makeHost();

    new HttpExceptionFilter().catch(new BadRequestException('Nope'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Nope', statusCode: 400 }),
    );
  });

  it('garde le 500 générique sur une erreur sans statut', () => {
    const { host, status, json } = makeHost();

    new HttpExceptionFilter().catch(new Error('boom'), host);

    expect(status).toHaveBeenCalledWith(500);
    // Le message interne ne sort jamais.
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Erreur interne du serveur' }),
    );
  });

  /**
   * ⚠️ Le garde-fou qui compte.
   *
   * `AxiosError` porte `status` — celui de la réponse **amont**. Sans
   * restriction, une clé Infobip révoquée (401 chez le prestataire) ferait
   * répondre 401 à *notre* client ; `ErrorInterceptor` côté Flutter le traduit
   * en `ApiErrorKind.unauthorized`, c'est-à-dire en déconnexion de session.
   * Une panne de configuration SMS déconnecterait les utilisateurs.
   *
   * On n'accorde le statut qu'aux erreurs qui déclarent explicitement être
   * exposables (`expose: true`, convention `http-errors` que suit
   * `body-parser`). Tout le reste reste un 500 générique.
   */
  it('ne recopie PAS le statut d’une erreur amont (axios)', () => {
    const { host, status, json } = makeHost();
    const upstream = new Error('Unauthorized') as Error & { status: number };
    upstream.status = 401; // pas d'`expose` : ce n'est pas notre contrat

    new HttpExceptionFilter().catch(upstream, host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Erreur interne du serveur' }),
    );
  });

  it('ignore un statut hors de la plage HTTP plutôt que de le recopier', () => {
    const { host, status } = makeHost();
    const err = new Error('bizarre') as Error & { status: number };
    err.status = 42;

    new HttpExceptionFilter().catch(err, host);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('respecte un statut explicitement exposable', () => {
    const { host, status, json } = makeHost();
    const err = new Error('trop de requêtes') as Error & {
      status: number;
      expose: boolean;
    };
    err.status = 429;
    err.expose = true;

    new HttpExceptionFilter().catch(err, host);

    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 429, message: 'trop de requêtes' }),
    );
  });
});
