import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LocationPrecision } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { haversineKm, sanitizeCoordinates } from '../../common/geo/congo-geo';

/**
 * Destination résolue d'une commande, telle qu'elle sera figée sur l'`Order`.
 */
export interface ResolvedDestination {
  /** Texte lisible par le livreur, quartier compris. */
  address: string;
  latitude: number | null;
  longitude: number | null;
  precision: LocationPrecision;
  quartierId: string | null;
  quartierNom: string | null;
  landmark: string | null;
}

/**
 * Résout **côté serveur** la destination d'une livraison à partir de l'adresse
 * choisie par le client.
 *
 * ## Pourquoi ce service existe
 *
 * Le client Flutter envoyait `deliveryLatitude` / `deliveryLongitude` lus sur
 * le GPS du téléphone au moment de payer. Le serveur les recopiait tels quels.
 * Conséquence : commander depuis son bureau pour une livraison à domicile
 * envoyait le livreur au bureau, et la commande portait deux destinations
 * contradictoires — un texte (l'adresse choisie) et un point (le téléphone).
 *
 * Le corps de la requête n'est donc plus une source de vérité. La destination
 * se déduit de l'adresse, et d'elle seule.
 *
 * ## L'ordre de repli, et pourquoi il s'arrête là
 *
 * 1. **`Adresses.latitude/longitude`** → `EXACT`. Le client a posé le point.
 * 2. **Centroïde du `Quartier`** → `APPROXIMATE`. Le point est vrai à l'échelle
 *    du quartier, faux à l'échelle de la rue. Le livreur devra appeler ; c'est
 *    exactement ce que `APPROXIMATE` lui dit.
 * 3. **Rien** → `UNKNOWN`, coordonnées `null`.
 *
 * Il n'y a **pas** de quatrième repli sur le centre de Brazzaville. Un point
 * faux présenté comme une destination est pire que pas de point : il est
 * indiscernable d'une vraie adresse, et le livreur s'y rend.
 *
 * On ne rejette pas non plus la commande au niveau 3 : une adresse ancienne
 * sans coordonnées reste livrable — elle l'était hier — et fermer la caisse
 * pour une donnée manquante coûterait plus que de l'afficher honnêtement.
 */
@Injectable()
export class DeliveryDestinationService {
  private readonly logger = new Logger(DeliveryDestinationService.name);

  /**
   * Au-delà de cette distance entre la position déclarée par le client et la
   * destination résolue, on journalise. Ce n'est pas une erreur — le client a
   * parfaitement le droit de commander depuis l'autre bout de la ville — mais
   * c'est la mesure qui aurait révélé le défaut d'origine en quelques heures.
   */
  private static readonly DIVERGENCE_LOG_THRESHOLD_KM = 2;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param adresseId  adresse choisie par le client
   * @param userId     propriétaire attendu (Prisma `User.id`)
   * @param clientReportedPosition position GPS envoyée par l'app, **à titre
   *        purement informatif** : elle ne sert qu'à mesurer l'écart et n'entre
   *        jamais dans la destination.
   */
  async resolveForAddress(
    adresseId: string,
    userId: string,
    clientReportedPosition?: { latitude?: number; longitude?: number },
  ): Promise<ResolvedDestination> {
    const adresse = await this.prisma.adresses.findUnique({
      where: { id: adresseId },
      include: {
        quartier: {
          select: { id: true, nom: true, latitude: true, longitude: true },
        },
      },
    });

    if (!adresse) {
      throw new NotFoundException('Adresse de livraison introuvable.');
    }
    if (adresse.userId !== userId) {
      throw new ForbiddenException('Cette adresse ne vous appartient pas.');
    }

    const destination = this.pickCoordinates(adresse);
    this.logResolution(adresseId, adresse, destination.precision);

    const resolved: ResolvedDestination = {
      address: this.formatAddress(adresse),
      latitude: destination.latitude,
      longitude: destination.longitude,
      precision: destination.precision,
      quartierId: adresse.quartierId,
      quartierNom: adresse.quartier?.nom ?? null,
      landmark: adresse.landmark,
    };

    this.logDivergence(adresseId, resolved, clientReportedPosition);
    return resolved;
  }

  /**
   * Applique l'ordre de repli. Les coordonnées lues en base repassent par
   * `sanitizeCoordinates` : une ligne écrite avant les contrôles de validation
   * peut porter n'importe quoi, et on préfère descendre d'un cran plutôt que
   * de propager un point aberrant jusqu'à la carte du livreur.
   */
  private pickCoordinates(adresse: {
    latitude: number | null;
    longitude: number | null;
    locationPrecision: LocationPrecision;
    quartier: { latitude: number | null; longitude: number | null } | null;
  }): {
    latitude: number | null;
    longitude: number | null;
    precision: LocationPrecision;
  } {
    const own = sanitizeCoordinates(adresse.latitude, adresse.longitude);
    if (own) {
      return {
        ...own,
        // `locationPrecision` de l'adresse fait foi si elle est déjà
        // qualifiée : une adresse dont la position vient d'un centroïde ne
        // doit pas devenir `EXACT` en passant par ici.
        precision:
          adresse.locationPrecision === LocationPrecision.UNKNOWN
            ? LocationPrecision.EXACT
            : adresse.locationPrecision,
      };
    }

    const centroid = sanitizeCoordinates(
      adresse.quartier?.latitude,
      adresse.quartier?.longitude,
    );
    if (centroid) {
      return { ...centroid, precision: LocationPrecision.APPROXIMATE };
    }

    return {
      latitude: null,
      longitude: null,
      precision: LocationPrecision.UNKNOWN,
    };
  }

  /**
   * Texte destiné au livreur.
   *
   * L'ancien format était `"{rue}, {ville}, {country}"` — le quartier en était
   * absent, alors qu'à Brazzaville il porte plus d'information que le nom de
   * rue. « Congo » n'en portait aucune : toutes les livraisons y sont.
   */
  private formatAddress(adresse: {
    rue: string;
    ville: string;
    quartier: { nom: string } | null;
  }): string {
    return [adresse.rue, adresse.quartier?.nom, adresse.ville]
      .map((part) => part?.trim())
      .filter((part): part is string => !!part)
      .join(', ');
  }

  /**
   * Journalise le niveau de repli atteint, avec un code stable.
   *
   * Sans cette trace, la dégradation est **muette** : une adresse dont les
   * coordonnées sont aberrantes en base descend d'un cran en silence, et une
   * commande sans destination exploitable ne se distingue d'une commande
   * normale qu'en relisant la ligne. Ce sont précisément les deux situations
   * qu'on veut compter — la première dit qu'une donnée est à réparer, la
   * seconde qu'un quartier attend son centroïde.
   *
   * L'`adresseId` suffit à retrouver la ligne ; aucune coordonnée ni identité
   * n'est écrite.
   */
  private logResolution(
    adresseId: string,
    adresse: {
      latitude: number | null;
      longitude: number | null;
      quartierId: string | null;
    },
    precision: LocationPrecision,
  ): void {
    // L'adresse portait un couple, il n'a pas survécu au contrôle : la donnée
    // en base est fausse, pas seulement absente. On rejoue `sanitizeCoordinates`
    // plutôt que de déduire du niveau atteint — une adresse peut légitimement
    // stocker un couple déjà qualifié `APPROXIMATE`, ce qui n'a rien d'une
    // anomalie.
    const own = sanitizeCoordinates(adresse.latitude, adresse.longitude);
    if (adresse.latitude !== null && adresse.longitude !== null && !own) {
      this.logger.warn(
        `INVALID_COORDINATES adresse=${adresseId} — coordonnées enregistrées ` +
          `rejetées par le contrôle Congo, repli sur ${precision}`,
      );
    }

    if (precision === LocationPrecision.UNKNOWN) {
      this.logger.warn(
        `DESTINATION_UNKNOWN adresse=${adresseId} quartier=${adresse.quartierId ?? 'aucun'} ` +
          `— aucune position fiable, la commande partira sans destination ` +
          `(centroïde de quartier à poser via PATCH /quartiers/:id/centroid)`,
      );
    } else if (precision === LocationPrecision.APPROXIMATE) {
      this.logger.log(
        `DESTINATION_APPROXIMATE adresse=${adresseId} quartier=${adresse.quartierId ?? 'aucun'} ` +
          `— position à l'échelle du quartier`,
      );
    }
  }

  /**
   * Journalise l'écart entre « où était le client » et « où on livre ».
   *
   * Sans identité ni coordonnée en clair : l'`adresseId` et une distance
   * suffisent à diagnostiquer, une position exacte dans les logs serait une
   * donnée personnelle conservée sans raison.
   */
  private logDivergence(
    adresseId: string,
    resolved: ResolvedDestination,
    reported?: { latitude?: number; longitude?: number },
  ): void {
    if (resolved.latitude === null || resolved.longitude === null) return;
    const clientPos = sanitizeCoordinates(
      reported?.latitude,
      reported?.longitude,
    );
    if (!clientPos) return;

    const km = haversineKm(
      clientPos.latitude,
      clientPos.longitude,
      resolved.latitude,
      resolved.longitude,
    );
    if (km < DeliveryDestinationService.DIVERGENCE_LOG_THRESHOLD_KM) return;

    this.logger.log(
      `📍 [DESTINATION] adresse=${adresseId} precision=${resolved.precision} ` +
        `écart client↔destination=${km.toFixed(1)} km (position du téléphone ignorée, ` +
        `la destination vient de l'adresse)`,
    );
  }
}
