import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { RequestContext } from './request-context';

/**
 * Ouvre le périmètre de corrélation pour chaque requête HTTP.
 *
 * ⚠️ **L'identifiant n'est pas fabriqué ici.** Il vient de `req.id`, posé par
 * `pinoHttp.genReqId` (cf. `app.module.ts`), qui réutilise un `X-Request-Id`
 * entrant ou en génère un — et le renvoie au client. En générer un second
 * donnerait deux identifiants pour une même requête : celui des journaux et
 * celui de la corrélation, c'est-à-dire aucun.
 *
 * Le repli sur `x-request-id` couvre l'ordre de montage : si ce middleware
 * s'exécutait avant celui de pino, `req.id` serait absent. On préfère lire
 * l'en-tête plutôt que d'ouvrir un périmètre vide.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const fromPino = (req as Request & { id?: unknown }).id;
    const header = req.headers['x-request-id'];
    const requestId =
      (typeof fromPino === 'string' ? fromPino : undefined) ??
      (Array.isArray(header) ? header[0] : header);

    if (!requestId) {
      // Aucun identifiant exploitable : on n'ouvre pas de périmètre plutôt que
      // d'en ouvrir un vide, pour que `requestId()` rende `undefined` — une
      // information honnête — au lieu d'une chaîne inventée.
      next();
      return;
    }

    RequestContext.run(requestId, () => next());
  }
}
