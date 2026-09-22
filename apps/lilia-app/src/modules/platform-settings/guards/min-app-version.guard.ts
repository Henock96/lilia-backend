import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { PlatformSettingsService } from '../platform-settings.service';
import {
  compareAppVersions,
  formatAppVersion,
  parseAppVersion,
} from '../app-update-policy';

/** En-tête posé par `lilia-app` (≥ 1.3.1) sur toutes ses requêtes. */
export const APP_VERSION_HEADER = 'x-lilia-app-version';

/** `426 Upgrade Required` — absent de l'énumération `HttpStatus` de Nest. */
const HTTP_UPGRADE_REQUIRED = 426;

/**
 * Applique `minAppVersion` **côté serveur**, sur la seule route qui compte :
 * `POST /orders/checkout` (UPD-003).
 *
 * ## Pourquoi
 *
 * Jusqu'ici le blocage était purement déclaratif : c'est l'application qui
 * décidait de s'afficher bloquée. Un binaire dont le dialogue a un défaut, ou
 * qui a été construit avant le mécanisme, commandait normalement sous le seuil.
 *
 * ## Ce que ce guard ne fait PAS — et pourquoi
 *
 * - **En-tête absent ⇒ laissé passer.** Les binaires antérieurs à 1.3.1 ne
 *   l'envoient pas, le site web non plus. Les refuser casserait des clients
 *   qui fonctionnent, sans leur dire pourquoi (ils ne savent pas lire un 426).
 *   Ce guard protège les binaires *futurs* ; pour les anciens, le levier reste
 *   le dialogue de l'application.
 * - **En-tête illisible ⇒ laissé passer.** Même règle que les clients : une
 *   valeur qu'on ne comprend pas n'est pas un seuil.
 * - **Aucune autre route n'est gardée.** Le binaire périmé doit pouvoir
 *   s'authentifier, lire `GET /platform-settings` (qui lui apprend qu'il est
 *   périmé et où se mettre à jour), consulter ses commandes et payer celles
 *   déjà créées. Bloquer davantage créerait la boucle « mise à jour requise →
 *   API refusée → impossible d'apprendre où se mettre à jour ».
 *
 * L'en-tête est déclaratif : un client peut mentir. Ce n'est pas une barrière
 * de sécurité mais de **compatibilité** — elle arrête un binaire honnête qui
 * parlerait un contrat d'API retiré.
 */
@Injectable()
export class MinAppVersionGuard implements CanActivate {
  private readonly logger = new Logger(MinAppVersionGuard.name);

  constructor(private readonly settings: PlatformSettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const raw = request.headers[APP_VERSION_HEADER];
    const declared = parseAppVersion(Array.isArray(raw) ? raw[0] : raw);
    if (!declared) return true;

    const { minAppVersion } = await this.settings.getSettings();
    const min = parseAppVersion(minAppVersion);
    if (!min || compareAppVersions(declared, min) >= 0) return true;

    this.logger.warn(
      `Commande refusée : binaire ${formatAppVersion(declared)} sous le seuil ` +
        `${formatAppVersion(min)}`,
    );
    throw new HttpException(
      {
        message:
          'Cette version de Lilia Food n’est plus prise en charge pour ' +
          'commander. Mettez l’application à jour depuis le store, puis ' +
          'reprenez votre panier : il est conservé.',
        code: 'APP_UPDATE_REQUIRED',
      },
      HTTP_UPGRADE_REQUIRED,
    );
  }
}
