import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import {
  DeliveryPlace,
  DeliveryQuote,
  DeliveryTariffSnapshot,
  quoteDelivery,
} from './delivery-pricing.engine';

export interface PricedVendor {
  id: string;
  latitude: number | null;
  longitude: number | null;
  quartierId: string | null;
  deliverySubsidyMode: 'NONE' | 'FIXED' | 'FREE_ABOVE';
  deliverySubsidyXaf: number | null;
  freeDeliveryThresholdXaf: number | null;
}

export type PricedDestination = DeliveryPlace;

/**
 * Alimente le moteur pur de tarification (F3-02) : mode plateforme, grille
 * publiée, position du vendeur.
 *
 * Le checkout et le devis public passent tous deux par `quoteForVendor` — un
 * seul chemin, donc un prix affiché qui est le prix facturé.
 *
 * Pas de cache : une commande est facturée sur la grille lue au moment où
 * elle est passée, et la version est figée sur la commande. Un cache à TTL
 * ferait facturer, pendant sa durée, une grille déjà remplacée.
 */
@Injectable()
export class DeliveryPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /**
   * `null` en mode `VENDOR_LEGACY` : l'appelant garde alors l'ancien calcul
   * (prix fixe ou zone du vendeur). C'est le drapeau de bascule (règle R4).
   */
  async quoteForVendor(input: {
    vendor: PricedVendor;
    destination: PricedDestination;
    subTotalXaf: number;
  }): Promise<DeliveryQuote | null> {
    const { deliveryPricingMode } = await this.settings.getSettings();
    if (deliveryPricingMode !== 'PLATFORM') return null;

    const tariff = await this.publishedTariff();
    // Plateforme activée sans grille : on refuse plutôt que de retomber sur
    // le prix du vendeur. Le repli silencieux rouvrirait exactement le défaut
    // que ce mode ferme (une course à 0 XAF qui ne paie pas le livreur).
    if (!tariff) {
      throw new ServiceUnavailableException(
        "La grille tarifaire de livraison n'est pas encore publiée. Réessayez dans quelques minutes.",
      );
    }

    const { vendor } = input;
    return quoteDelivery({
      tariff,
      origin: await this.vendorPlace(vendor),
      destination: await this.destinationPlace(input.destination),
      subsidy: {
        mode: vendor.deliverySubsidyMode,
        amountXaf: vendor.deliverySubsidyXaf,
        thresholdXaf: vendor.freeDeliveryThresholdXaf,
      },
      subTotalXaf: input.subTotalXaf,
    });
  }

  private floorCache: { value: number | null; expiresAt: number } | null = null;

  /**
   * Prix le plus bas de la grille publiée — « Livraison dès X » sur les
   * cartes vendeur. `null` en mode VENDOR_LEGACY ou sans grille.
   *
   * Affichage seulement, donc mis en cache 60 s (comme les réglages eux-mêmes)
   * : `GET /platform-settings` est lu à chaque ouverture d'app et ne doit pas
   * coûter une requête de plus. Rien n'est facturé sur cette valeur.
   */
  async publicFloorFeeXaf(): Promise<number | null> {
    const { deliveryPricingMode } = await this.settings.getSettings();
    if (deliveryPricingMode !== 'PLATFORM') return null;
    const now = Date.now();
    if (this.floorCache && this.floorCache.expiresAt > now) {
      return this.floorCache.value;
    }
    const { _min } = await this.prisma.deliveryTariffBand.aggregate({
      where: { tariff: { status: 'PUBLISHED' } },
      _min: { feeXaf: true },
    });
    const overrideMin = await this.prisma.deliveryTariffOverride.aggregate({
      where: { tariff: { status: 'PUBLISHED' } },
      _min: { feeXaf: true },
    });
    const candidates = [_min.feeXaf, overrideMin._min.feeXaf].filter(
      (v): v is number => v != null,
    );
    const value = candidates.length ? Math.min(...candidates) : null;
    this.floorCache = { value, expiresAt: now + 60_000 };
    return value;
  }

  async publishedTariff(): Promise<DeliveryTariffSnapshot | null> {
    const row = await this.prisma.deliveryTariff.findFirst({
      where: { status: 'PUBLISHED' },
      select: {
        version: true,
        roadFactor: true,
        bands: { select: { maxKm: true, feeXaf: true } },
        overrides: {
          select: {
            originQuartierId: true,
            destQuartierId: true,
            feeXaf: true,
          },
        },
      },
    });
    return row;
  }

  /**
   * Centroïde du quartier de destination, sinon le point de l'adresse.
   *
   * Le devis public ne connaît que le quartier du client ; le checkout connaît
   * le point exact. Mesurer jusqu'au point exact ferait facturer un autre prix
   * que celui affiché (R-02.7) : la distance se mesure au quartier (R-02.1).
   */
  private async destinationPlace(
    dest: PricedDestination,
  ): Promise<DeliveryPlace> {
    const quartier = dest.quartierId
      ? await this.prisma.quartier.findUnique({
          where: { id: dest.quartierId },
          select: { latitude: true, longitude: true },
        })
      : null;
    if (quartier?.latitude != null && quartier.longitude != null) {
      return {
        quartierId: dest.quartierId,
        latitude: quartier.latitude,
        longitude: quartier.longitude,
      };
    }
    return dest;
  }

  /** GPS du vendeur, sinon le centroïde de son quartier, sinon inconnu. */
  private async vendorPlace(vendor: PricedVendor): Promise<DeliveryPlace> {
    if (vendor.latitude != null && vendor.longitude != null) {
      return {
        quartierId: vendor.quartierId,
        latitude: vendor.latitude,
        longitude: vendor.longitude,
      };
    }
    const quartier = vendor.quartierId
      ? await this.prisma.quartier.findUnique({
          where: { id: vendor.quartierId },
          select: { latitude: true, longitude: true },
        })
      : null;
    return {
      quartierId: vendor.quartierId,
      latitude: quartier?.latitude ?? null,
      longitude: quartier?.longitude ?? null,
    };
  }
}
