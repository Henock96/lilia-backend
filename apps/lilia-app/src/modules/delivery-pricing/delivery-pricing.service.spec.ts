import { ServiceUnavailableException } from '@nestjs/common';
import { DeliveryPricingService } from './delivery-pricing.service';

/**
 * Service qui alimente le moteur pur (F3-02) : mode plateforme, grille
 * publiée, position du vendeur. Le checkout et le devis public passent tous
 * deux par lui — c'est ce qui les empêche de diverger.
 */
const TARIFF_ROW = {
  id: 't-3',
  version: 3,
  roadFactor: 1.3,
  bands: [
    { maxKm: 6, feeXaf: 1500 },
    { maxKm: 3, feeXaf: 1000 },
  ],
  overrides: [],
};

const VENDOR = {
  id: 'r-1',
  latitude: -4.2634,
  longitude: 15.2729,
  quartierId: 'q-poto',
  deliverySubsidyMode: 'NONE' as const,
  deliverySubsidyXaf: null,
  freeDeliveryThresholdXaf: null,
};

const DEST = {
  quartierId: 'q-moungali',
  latitude: -4.2454,
  longitude: 15.2629,
};

function build(
  opts: { mode?: string; tariff?: unknown; quartier?: unknown } = {},
) {
  const prisma = {
    deliveryTariff: {
      findFirst: jest
        .fn()
        .mockResolvedValue('tariff' in opts ? opts.tariff : TARIFF_ROW),
    },
    quartier: {
      findUnique: jest.fn().mockResolvedValue(opts.quartier ?? null),
    },
  };
  const settings = {
    getSettings: jest
      .fn()
      .mockResolvedValue({ deliveryPricingMode: opts.mode ?? 'PLATFORM' }),
  };
  const service = new DeliveryPricingService(
    prisma as never,
    settings as never,
  );
  return { service, prisma };
}

describe('DeliveryPricingService.quoteForVendor', () => {
  it('mode historique (VENDOR_LEGACY) : null, le vendeur fixe encore son prix', async () => {
    const { service, prisma } = build({ mode: 'VENDOR_LEGACY' });
    await expect(
      service.quoteForVendor({
        vendor: VENDOR,
        destination: DEST,
        subTotalXaf: 5000,
      }),
    ).resolves.toBeNull();
    // Aucune lecture de grille : le mode historique ne coûte rien.
    expect(prisma.deliveryTariff.findFirst).not.toHaveBeenCalled();
  });

  it('mode plateforme : lit la grille PUBLIÉE et la passe au moteur', async () => {
    const { service, prisma } = build();
    const q = await service.quoteForVendor({
      vendor: VENDOR,
      destination: DEST,
      subTotalXaf: 5000,
    });
    expect(prisma.deliveryTariff.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'PUBLISHED' } }),
    );
    expect(q).toMatchObject({
      tariffVersion: 3,
      baseFeeXaf: 1000,
      basis: 'BAND',
    });
  });

  it('mode plateforme sans grille publiée : refus explicite, jamais un repli sur le prix vendeur', async () => {
    const { service } = build({ tariff: null });
    await expect(
      service.quoteForVendor({
        vendor: VENDOR,
        destination: DEST,
        subTotalXaf: 5000,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('vendeur sans GPS : son quartier sert d’origine', async () => {
    const { service, prisma } = build({
      quartier: { latitude: -4.2634, longitude: 15.2729 },
    });
    const q = await service.quoteForVendor({
      vendor: { ...VENDOR, latitude: null, longitude: null },
      destination: DEST,
      subTotalXaf: 5000,
    });
    expect(prisma.quartier.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'q-poto' } }),
    );
    expect(q?.basis).toBe('BAND');
  });

  it('vendeur sans GPS ni centroïde : FALLBACK (tranche la plus haute)', async () => {
    const { service } = build();
    const q = await service.quoteForVendor({
      vendor: { ...VENDOR, latitude: null, longitude: null },
      destination: DEST,
      subTotalXaf: 5000,
    });
    expect(q).toMatchObject({ basis: 'FALLBACK', baseFeeXaf: 1500 });
  });

  it('applique la subvention du vendeur', async () => {
    const { service } = build();
    const q = await service.quoteForVendor({
      vendor: {
        ...VENDOR,
        deliverySubsidyMode: 'FIXED',
        deliverySubsidyXaf: 400,
      },
      destination: DEST,
      subTotalXaf: 5000,
    });
    expect(q).toMatchObject({
      baseFeeXaf: 1000,
      subsidyXaf: 400,
      customerFeeXaf: 600,
    });
  });

  /**
   * Le devis public ne connaît que le quartier du client, le checkout connaît
   * le point exact de l'adresse. Mesurer jusqu'au point exact ferait facturer
   * un autre prix que celui affiché (R-02.7) : la distance se mesure au
   * centroïde du quartier (R-02.1), le point de l'adresse n'est qu'un repli.
   */
  describe('destination', () => {
    it('le centroïde du quartier prime sur le point exact de l’adresse', async () => {
      const { service, prisma } = build();
      // Centroïde de Talangaï (~5,6 km de Poto-Poto → 7,2 km routiers → 3e tranche).
      prisma.quartier.findUnique.mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          where.id === 'q-talangai'
            ? { latitude: -4.2134, longitude: 15.2729 }
            : null,
      );
      const q = await service.quoteForVendor({
        vendor: VENDOR,
        // Point exact tout près du vendeur : s'il servait, on serait en 1re tranche.
        destination: {
          quartierId: 'q-talangai',
          latitude: -4.2635,
          longitude: 15.273,
        },
        subTotalXaf: 5000,
      });
      expect(q?.distanceKm).toBe(7.2);
      expect(q?.baseFeeXaf).toBe(1500);
    });

    it('quartier sans centroïde : le point de l’adresse sert de repli', async () => {
      const { service } = build();
      const q = await service.quoteForVendor({
        vendor: VENDOR,
        destination: DEST,
        subTotalXaf: 5000,
      });
      expect(q?.basis).toBe('BAND');
      expect(q?.distanceKm).toBe(3);
    });
  });
});
