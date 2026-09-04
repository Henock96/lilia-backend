import { OnboardingStatus, Role } from '@prisma/client';
import { VendorReadinessService } from './vendor-readiness.service';

/**
 * La checklist décide de ce qui peut être publié. Chaque règle est donc
 * vérifiée pour elle-même, dans les deux sens : sa présence ne doit pas bloquer,
 * son absence doit bloquer si — et seulement si — elle est bloquante.
 *
 * Ces cas sont écrits à la main plutôt que dérivés de la liste des règles :
 * une spec qui lit la même structure que le code se contente de vérifier que
 * le code sait lire sa propre configuration. C'est le piège relevé sur la
 * machine à états des commandes (audit du 29/08/2026).
 */
describe('VendorReadinessService', () => {
  let prisma: {
    restaurant: { findUnique: jest.Mock };
    product: { count: jest.Mock };
  };
  let service: VendorReadinessService;

  /** Vendeur entièrement configuré — toute case cochée. */
  const completeVendor = () => ({
    id: 'r1',
    nom: 'Chez Lilia',
    description: 'Cuisine congolaise maison',
    phone: '060000001',
    imageUrl: 'https://cdn/logo.png',
    adresse: '12 rue des Manguiers',
    quartierId: 'q1',
    latitude: -4.2634,
    longitude: 15.2429,
    commissionPercent: null,
    // Compte de reversement : sans lui, le vendeur encaisse sans jamais
    // pouvoir être payé. Format normalisé par `toMsisdn` (242 + 0 + 4/5/6 + 7).
    payoutPhoneNumber: '242060000001',
    payoutProvider: 'MTN_MOMO_COG',
    supportsDelivery: true,
    supportsPickup: true,
    deliveryPriceMode: 'FIXED',
    estimatedDeliveryTimeMin: 15,
    estimatedDeliveryTimeMax: 30,
    onboardingStatus: OnboardingStatus.DRAFT,
    owner: { role: Role.RESTAURATEUR, statusUser: 'ACTIVE' },
    operatingHours: [{ isClosed: false }],
    photos: [{ id: 'p1' }],
    deliveryZones: [],
  });

  const load = (overrides: Record<string, unknown> = {}, products = 3) => {
    prisma.restaurant.findUnique.mockResolvedValue({
      ...completeVendor(),
      ...overrides,
    });
    prisma.product.count.mockResolvedValue(products);
    return service.getReport('r1');
  };

  const check = (report: Awaited<ReturnType<typeof load>>, key: string) =>
    report!.checks.find((c) => c.key === key)!;

  beforeEach(() => {
    prisma = {
      restaurant: { findUnique: jest.fn() },
      product: { count: jest.fn() },
    };
    service = new VendorReadinessService(prisma as never);
  });

  it('renvoie null pour un vendeur inexistant', async () => {
    prisma.restaurant.findUnique.mockResolvedValue(null);
    expect(await service.getReport('inconnu')).toBeNull();
  });

  it('déclare prêt un vendeur entièrement configuré', async () => {
    const report = await load();
    expect(report!.isReady).toBe(true);
    expect(report!.progress).toBe(100);
    expect(report!.blockingIssues).toEqual([]);
  });

  // ─── Compte vendeur ────────────────────────────────────────────────────────

  it('bloque si le propriétaire est resté CLIENT', async () => {
    const report = await load({
      owner: { role: Role.CLIENT, statusUser: 'ACTIVE' },
    });
    expect(report!.isReady).toBe(false);
    expect(check(report, 'owner').status).toBe('INVALID');
  });

  it('bloque si le compte du propriétaire est bloqué', async () => {
    const report = await load({
      owner: { role: Role.RESTAURATEUR, statusUser: 'BLOCKED' },
    });
    expect(check(report, 'owner').status).toBe('INVALID');
  });

  // ─── Identité et visuels ───────────────────────────────────────────────────

  it('bloque sans logo', async () => {
    const report = await load({ imageUrl: null });
    expect(report!.isReady).toBe(false);
    expect(check(report, 'logo').status).toBe('MISSING');
  });

  it('signale la description manquante sans bloquer', async () => {
    const report = await load({ description: null });
    expect(check(report, 'description').status).toBe('MISSING');
    expect(check(report, 'description').blocking).toBe(false);
    expect(report!.isReady).toBe(true);
  });

  it('signale la couverture manquante sans bloquer', async () => {
    const report = await load({ photos: [] });
    expect(check(report, 'cover').status).toBe('MISSING');
    expect(report!.isReady).toBe(true);
  });

  // ─── Localisation ──────────────────────────────────────────────────────────

  it('bloque sans quartier', async () => {
    const report = await load({ quartierId: null });
    expect(check(report, 'location').status).toBe('MISSING');
  });

  it('bloque sans GPS', async () => {
    const report = await load({ latitude: null, longitude: null });
    expect(check(report, 'gps').status).toBe('MISSING');
  });

  it('rejette des coordonnées hors du Congo', async () => {
    // Paris : plausible en base, absurde pour une ETA de livraison.
    const report = await load({ latitude: 48.85, longitude: 2.35 });
    expect(check(report, 'gps').status).toBe('INVALID');
    expect(check(report, 'gps').detail).toContain('inversées');
  });

  it('rejette une latitude non finie', async () => {
    const report = await load({ latitude: Number.NaN });
    expect(check(report, 'gps').status).toBe('INVALID');
  });

  // ─── Horaires ──────────────────────────────────────────────────────────────

  it('bloque sans aucun horaire', async () => {
    const report = await load({ operatingHours: [] });
    expect(check(report, 'hours').status).toBe('MISSING');
  });

  it('bloque si les sept jours sont fermés', async () => {
    const report = await load({
      operatingHours: Array.from({ length: 7 }, () => ({ isClosed: true })),
    });
    expect(check(report, 'hours').status).toBe('INVALID');
  });

  // ─── Livraison ─────────────────────────────────────────────────────────────

  it('bloque si ni livraison ni retrait', async () => {
    const report = await load({
      supportsDelivery: false,
      supportsPickup: false,
    });
    expect(check(report, 'delivery').status).toBe('INVALID');
  });

  it('accepte un vendeur en retrait seul', async () => {
    const report = await load({
      supportsDelivery: false,
      supportsPickup: true,
    });
    expect(check(report, 'delivery').status).toBe('OK');
    expect(report!.isReady).toBe(true);
  });

  it('bloque une tarification par zone sans aucune zone', async () => {
    const report = await load({
      deliveryPriceMode: 'ZONE_BASED',
      deliveryZones: [],
    });
    expect(check(report, 'delivery').status).toBe('MISSING');
  });

  it("n'exige pas de zone si le vendeur ne livre pas", async () => {
    const report = await load({
      deliveryPriceMode: 'ZONE_BASED',
      deliveryZones: [],
      supportsDelivery: false,
      supportsPickup: true,
    });
    expect(check(report, 'delivery').status).toBe('OK');
  });

  it('bloque un délai minimum supérieur au maximum', async () => {
    const report = await load({
      estimatedDeliveryTimeMin: 60,
      estimatedDeliveryTimeMax: 20,
    });
    expect(check(report, 'delivery').status).toBe('INVALID');
  });

  // ─── Commission ────────────────────────────────────────────────────────────

  it('accepte une commission nulle (taux plateforme)', async () => {
    const report = await load({ commissionPercent: null });
    expect(check(report, 'commerce').status).toBe('OK');
  });

  it('signale une commission hors bornes sans bloquer la publication', async () => {
    const report = await load({ commissionPercent: 90 });
    expect(check(report, 'commerce').status).toBe('INVALID');
    expect(check(report, 'commerce').blocking).toBe(false);
  });

  // ─── Catalogue ─────────────────────────────────────────────────────────────

  it('bloque une boutique sans produit vendable', async () => {
    const report = await load({}, 0);
    expect(report!.isReady).toBe(false);
    expect(check(report, 'catalog').status).toBe('MISSING');
  });

  it('ne compte que les produits réellement vendables', async () => {
    await load();
    // Un produit supprimé, indisponible, à prix nul ou sans variante ne rend
    // pas une boutique commandable : la requête doit les exclure.
    expect(prisma.product.count).toHaveBeenCalledWith({
      where: {
        restaurantId: 'r1',
        deletedAt: null,
        isAvailable: true,
        prixOriginal: { gt: 0 },
        variants: { some: {} },
      },
    });
  });

  // ─── Compte de reversement (P0-1) ─────────────────────────────────────────

  it('bloque un vendeur sans compte de reversement', async () => {
    // L'état réel des six vendeurs de production au 4 septembre 2026 : publiés,
    // encaissant, et impossibles à payer. La checklist ne posait pas la
    // question, donc personne ne pouvait y répondre.
    const report = await load({
      payoutPhoneNumber: null,
      payoutProvider: null,
    });
    expect(check(report, 'payout').status).toBe('MISSING');
    expect(check(report, 'payout').blocking).toBe(true);
    expect(report!.isReady).toBe(false);
  });

  it('bloque un numéro renseigné sans opérateur', async () => {
    const report = await load({ payoutProvider: null });
    expect(check(report, 'payout').status).toBe('MISSING');
    expect(report!.isReady).toBe(false);
  });

  it('bloque un numéro de reversement mal formé', async () => {
    // Se tromper de format ne produit aucune erreur au moment du virement :
    // l'argent part vers un numéro inexistant, ou vers quelqu'un d'autre.
    const report = await load({ payoutPhoneNumber: '061234567' });
    expect(check(report, 'payout').status).toBe('INVALID');
    expect(report!.isReady).toBe(false);
  });

  it('bloque un numéro sans le zéro initial (forme à onze chiffres)', async () => {
    const report = await load({ payoutPhoneNumber: '24261234567' });
    expect(check(report, 'payout').status).toBe('INVALID');
  });

  it('accepte un compte Airtel correctement normalisé', async () => {
    const report = await load({
      payoutPhoneNumber: '242050000002',
      payoutProvider: 'AIRTEL_COG',
    });
    expect(check(report, 'payout').status).toBe('OK');
    expect(report!.isReady).toBe(true);
  });

  // ─── Progression ───────────────────────────────────────────────────────────

  it('calcule la progression sur les seules cases bloquantes', async () => {
    const partial = await load(
      { imageUrl: null, latitude: null, longitude: null },
      0,
    );
    expect(partial!.progress).toBeLessThan(100);
    expect(partial!.progress).toBeGreaterThan(0);
    expect(partial!.blockingIssues.length).toBe(3);
  });
});
