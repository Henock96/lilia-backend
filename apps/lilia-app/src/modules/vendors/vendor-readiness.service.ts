import { Injectable } from '@nestjs/common';
import { DeliveryPriceMode, OnboardingStatus, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { checkCongoCoordinates } from '../../common/geo/congo-geo';

/**
 * Bornes géographiques de la République du Congo.
 *
 * Réexport de compatibilité : la définition vit désormais dans
 * `common/geo/congo-geo.ts`, partagée avec les adresses clients. Une latitude
 * de Paris sur un vendeur de Brazzaville produit une distance de 6 000 km,
 * donc une ETA absurde et un itinéraire livreur inutilisable.
 */
export { CONGO_BOUNDS } from '../../common/geo/congo-geo';

export type ReadinessStatus = 'OK' | 'MISSING' | 'INVALID';

export interface ReadinessCheck {
  /** Identifiant stable, consommé par les fronts pour router vers l'étape. */
  key: string;
  label: string;
  status: ReadinessStatus;
  /** Une case non bloquante manquante n'empêche pas l'activation. */
  blocking: boolean;
  detail?: string;
}

export interface ReadinessReport {
  restaurantId: string;
  onboardingStatus: OnboardingStatus;
  /** Toutes les cases bloquantes sont cochées. */
  isReady: boolean;
  /** Avancement affichable, cases bloquantes uniquement (0–100). */
  progress: number;
  checks: ReadinessCheck[];
  blockingIssues: string[];
}

/**
 * Checklist « prêt à vendre » — **seule** autorité sur la question.
 *
 * Elle est calculée à partir des données elles-mêmes, jamais stockée : une
 * colonne « configuré » se désynchroniserait dès la première écriture hors
 * service (script d'admin, correction en base, futur endpoint). Ici, supprimer
 * le dernier produit d'un vendeur le rend mécaniquement non-prêt, sans qu'aucun
 * code n'ait à y penser.
 *
 * Les fronts l'affichent, ils ne la recalculent pas : deux implémentations de
 * la même règle divergent toujours, et c'est celle du serveur qui décide.
 */
@Injectable()
export class VendorReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async getReport(restaurantId: string): Promise<ReadinessReport | null> {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        owner: { select: { role: true, statusUser: true } },
        operatingHours: { select: { isClosed: true } },
        photos: { where: { isCover: true }, select: { id: true } },
        deliveryZones: { select: { id: true } },
      },
    });
    if (!vendor) return null;

    const sellableProducts = await this.prisma.product.count({
      where: {
        restaurantId,
        deletedAt: null,
        isAvailable: true,
        prixOriginal: { gt: 0 },
        variants: { some: {} },
      },
    });

    const checks: ReadinessCheck[] = [
      this.checkOwner(vendor.owner),
      this.checkIdentity(vendor),
      this.checkDescription(vendor),
      this.checkLogo(vendor),
      this.checkCover(vendor),
      this.checkLocation(vendor),
      this.checkGps(vendor),
      this.checkHours(vendor),
      this.checkDelivery(vendor),
      this.checkCommerce(vendor),
      this.checkCatalog(sellableProducts),
    ];

    const blocking = checks.filter((c) => c.blocking);
    const satisfied = blocking.filter((c) => c.status === 'OK');

    return {
      restaurantId,
      onboardingStatus: vendor.onboardingStatus,
      isReady: satisfied.length === blocking.length,
      progress: Math.round((satisfied.length / blocking.length) * 100),
      checks,
      blockingIssues: blocking
        .filter((c) => c.status !== 'OK')
        .map((c) => c.detail ?? c.label),
    };
  }

  // ─── Règles ────────────────────────────────────────────────────────────────

  private checkOwner(owner: {
    role: Role;
    statusUser: string;
  }): ReadinessCheck {
    const base = { key: 'owner', label: 'Compte vendeur', blocking: true };
    if (owner.role !== Role.RESTAURATEUR && owner.role !== Role.ADMIN) {
      return {
        ...base,
        status: 'INVALID',
        detail: `Le propriétaire a le rôle ${owner.role} au lieu de RESTAURATEUR — il ne pourra pas accéder à son espace.`,
      };
    }
    if (owner.statusUser !== 'ACTIVE') {
      return {
        ...base,
        status: 'INVALID',
        detail: `Le compte du propriétaire est ${owner.statusUser}.`,
      };
    }
    return { ...base, status: 'OK' };
  }

  private checkIdentity(v: { nom: string; phone: string }): ReadinessCheck {
    const base = { key: 'identity', label: 'Identité', blocking: true };
    if (!v.nom?.trim() || v.nom.trim().length < 2) {
      return {
        ...base,
        status: 'MISSING',
        detail: 'Nom du commerce manquant.',
      };
    }
    if (!v.phone?.trim()) {
      return {
        ...base,
        status: 'MISSING',
        detail: 'Téléphone du commerce manquant.',
      };
    }
    return { ...base, status: 'OK' };
  }

  private checkDescription(v: { description: string | null }): ReadinessCheck {
    // Non bloquant : une boutique sans description se vend moins bien, mais
    // elle se vend. Refuser l'activation pour ça bloquerait un vendeur prêt.
    return {
      key: 'description',
      label: 'Description',
      blocking: false,
      status: v.description?.trim() ? 'OK' : 'MISSING',
      detail: v.description?.trim()
        ? undefined
        : 'Recommandé : le client ne saura pas ce que vous vendez.',
    };
  }

  private checkLogo(v: { imageUrl: string | null }): ReadinessCheck {
    return {
      key: 'logo',
      label: 'Logo',
      blocking: true,
      status: v.imageUrl?.trim() ? 'OK' : 'MISSING',
      detail: v.imageUrl?.trim()
        ? undefined
        : 'Le logo apparaît sur chaque carte du catalogue.',
    };
  }

  private checkCover(v: { photos: { id: string }[] }): ReadinessCheck {
    return {
      key: 'cover',
      label: 'Photo de couverture',
      blocking: false,
      status: v.photos.length > 0 ? 'OK' : 'MISSING',
      detail:
        v.photos.length > 0 ? undefined : 'Recommandé pour la page vendeur.',
    };
  }

  private checkLocation(v: {
    adresse: string;
    quartierId: string | null;
  }): ReadinessCheck {
    const base = { key: 'location', label: 'Localisation', blocking: true };
    if (!v.adresse?.trim()) {
      return { ...base, status: 'MISSING', detail: 'Adresse manquante.' };
    }
    if (!v.quartierId) {
      return {
        ...base,
        status: 'MISSING',
        detail:
          'Quartier manquant — nécessaire au calcul des frais de livraison.',
      };
    }
    return { ...base, status: 'OK' };
  }

  private checkGps(v: {
    latitude: number | null;
    longitude: number | null;
  }): ReadinessCheck {
    const base = { key: 'gps', label: 'Coordonnées GPS', blocking: true };
    if (v.latitude === null || v.longitude === null) {
      return {
        ...base,
        status: 'MISSING',
        detail:
          "Sans GPS, l'ETA de livraison et le trajet du livreur sont faux.",
      };
    }
    // Contrôle délégué à `common/geo` : les mêmes règles servent désormais aux
    // adresses clients, pour que les deux extrémités de la course soient
    // tenues au même standard.
    const check = checkCongoCoordinates(v.latitude, v.longitude);
    if (!check.ok) {
      return {
        ...base,
        status: 'INVALID',
        detail: `${check.message} (${v.latitude}, ${v.longitude})`,
      };
    }
    return { ...base, status: 'OK' };
  }

  private checkHours(v: {
    operatingHours: { isClosed: boolean }[];
  }): ReadinessCheck {
    const base = {
      key: 'hours',
      label: "Horaires d'ouverture",
      blocking: true,
    };
    if (v.operatingHours.length === 0) {
      return {
        ...base,
        status: 'MISSING',
        detail: 'Aucun horaire — la boutique resterait fermée en permanence.',
      };
    }
    if (v.operatingHours.every((h) => h.isClosed)) {
      return {
        ...base,
        status: 'INVALID',
        detail: 'Tous les jours sont marqués fermés.',
      };
    }
    return { ...base, status: 'OK' };
  }

  private checkDelivery(v: {
    supportsDelivery: boolean;
    supportsPickup: boolean;
    deliveryPriceMode: DeliveryPriceMode;
    deliveryZones: { id: string }[];
    estimatedDeliveryTimeMin: number;
    estimatedDeliveryTimeMax: number;
  }): ReadinessCheck {
    const base = { key: 'delivery', label: 'Livraison', blocking: true };
    if (!v.supportsDelivery && !v.supportsPickup) {
      return {
        ...base,
        status: 'INVALID',
        detail:
          'Ni livraison ni retrait : le client ne pourrait pas être servi.',
      };
    }
    if (
      v.supportsDelivery &&
      v.deliveryPriceMode === DeliveryPriceMode.ZONE_BASED &&
      v.deliveryZones.length === 0
    ) {
      return {
        ...base,
        status: 'MISSING',
        detail: 'Tarification par zone choisie, mais aucune zone définie.',
      };
    }
    if (v.estimatedDeliveryTimeMin > v.estimatedDeliveryTimeMax) {
      return {
        ...base,
        status: 'INVALID',
        detail: 'Le délai minimum dépasse le délai maximum.',
      };
    }
    return { ...base, status: 'OK' };
  }

  private checkCommerce(v: {
    commissionPercent: number | null;
  }): ReadinessCheck {
    // Non bloquant : `null` signifie « taux plateforme », qui est un choix
    // valide et le cas le plus courant. On signale seulement une valeur aberrante.
    const base = {
      key: 'commerce',
      label: 'Paramètres commerciaux',
      blocking: false,
    };
    if (v.commissionPercent === null) {
      return { ...base, status: 'OK', detail: 'Taux plateforme appliqué.' };
    }
    if (v.commissionPercent < 0 || v.commissionPercent > 50) {
      return {
        ...base,
        status: 'INVALID',
        detail: `Commission de ${v.commissionPercent} % hors bornes (0–50).`,
      };
    }
    return { ...base, status: 'OK' };
  }

  private checkCatalog(sellableProducts: number): ReadinessCheck {
    return {
      key: 'catalog',
      label: 'Catalogue',
      blocking: true,
      status: sellableProducts > 0 ? 'OK' : 'MISSING',
      detail:
        sellableProducts > 0
          ? `${sellableProducts} produit(s) vendable(s).`
          : 'Aucun produit vendable : le client verrait une boutique vide.',
    };
  }
}
