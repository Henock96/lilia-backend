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
import { APP_VERSION_HEADER } from './min-app-version.guard';
import {
  ORDER_FLOW_HEADER,
  declaresAcceptFirst,
} from '../../orders/order-flow';

/** En-tête posé par l'app vendeurs (lot 1C) : `vendor`. */
export const APP_NAME_HEADER = 'x-lilia-app';

const HTTP_UPGRADE_REQUIRED = 426;

/**
 * Compatibilité des applications vendeurs (durcissement lot 3, 30/10/2026).
 *
 * Posée sur les routes vendeur des commandes (liste, fiche, accepter,
 * refuser, statut, remise). N'agit que sur le rôle `RESTAURATEUR` : le client
 * et l'administrateur passent sans contrôle.
 *
 * Deux refus, tous deux `426` avec un message lisible — c'est la « réponse
 * maîtrisée » attendue d'une ancienne application :
 *
 *  1. **Version trop ancienne** — l'app vendeurs (`X-Lilia-App: vendor`)
 *     déclare une version sous `minVendorAppVersion`. Comme
 *     `MinAppVersionGuard` : en-tête absent ou illisible ⇒ laissé passer (ce
 *     n'est pas une barrière de sécurité, l'en-tête est déclaratif).
 *  2. **Parcours inconnu** — `orderFlow = ACCEPT_FIRST` et l'application
 *     n'annonce pas `X-Lilia-Order-Flow: accept-first`. Elle ne saurait pas
 *     afficher une demande `DEMANDE_ENVOYEE`, donc pas y répondre : la laisser
 *     lister les commandes, c'est laisser expirer des demandes en silence.
 *     Ce refus-là vaut aussi sans en-tête : les anciennes versions n'en
 *     envoient aucun, c'est précisément elles qu'il faut arrêter.
 *
 * Réglages par défaut (aucun seuil, `PAY_FIRST`) : la garde ne refuse rien.
 */
@Injectable()
export class VendorAppCompatGuard implements CanActivate {
  private readonly logger = new Logger(VendorAppCompatGuard.name);

  constructor(private readonly settings: PlatformSettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: { id: string; role: string } }>();
    if (request.user?.role !== 'RESTAURATEUR') return true;

    const { minVendorAppVersion, orderFlow } =
      await this.settings.getSettings();

    const app = header(request, APP_NAME_HEADER)?.trim().toLowerCase();
    if (app === 'vendor') {
      const declared = parseAppVersion(header(request, APP_VERSION_HEADER));
      const min = parseAppVersion(minVendorAppVersion);
      if (declared && min && compareAppVersions(declared, min) < 0) {
        this.logger.warn(
          `App vendeurs ${formatAppVersion(declared)} sous le seuil ${formatAppVersion(min)} (vendeur ${request.user.id})`,
        );
        throw upgradeRequired(
          'Cette version de l’application vendeurs n’est plus prise en charge. Mettez-la à jour depuis le store pour continuer à recevoir vos commandes.',
        );
      }
    }

    if (
      orderFlow === 'ACCEPT_FIRST' &&
      !declaresAcceptFirst(request.headers[ORDER_FLOW_HEADER])
    ) {
      this.logger.warn(
        `Vendeur ${request.user.id} sur une application sans « accept-first » (app : ${app ?? 'non déclarée'})`,
      );
      throw upgradeRequired(
        'Les commandes passent désormais par une demande à accepter avant paiement. Mettez à jour votre application (ou rechargez le back-office) pour les recevoir.',
      );
    }
    return true;
  }
}

function header(request: Request, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function upgradeRequired(message: string): HttpException {
  return new HttpException(
    { message, code: 'VENDOR_APP_UPDATE_REQUIRED' },
    HTTP_UPGRADE_REQUIRED,
  );
}
