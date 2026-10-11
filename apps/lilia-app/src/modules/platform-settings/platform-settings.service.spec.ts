import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PlatformSettingsService } from './platform-settings.service';
import { PrismaService } from '../../prisma/prisma.service';

const LOADED_AT = new Date('2026-09-22T10:00:00.000Z');
const WRITTEN_AT = new Date('2026-09-22T10:05:00.000Z');
const MSG = 'Retour à 14 h';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'singleton',
    serviceFeePercent: 15,
    restaurantCommissionPercent: 10,
    loyaltyPointsPerOrder: 1,
    loyaltyPointValueXaf: 50,
    loyaltyMinRedemption: 1,
    referrerBonusPoints: 1,
    groceryServiceFeeBps: null,
    vendorPayoutAutoEnabled: false,
    vendorPayoutDelayMinutes: 60,
    deliveryPricingMode: 'VENDOR_LEGACY',
    maintenanceMode: false,
    maintenanceMessage: null,
    minAppVersion: '1.3.0',
    latestAppVersion: '1.3.0',
    updateUrlAndroid: null,
    updateUrlIos: null,
    updateMessage: null,
    updatedAt: LOADED_AT,
    ...overrides,
  };
}

describe('PlatformSettingsService', () => {
  let service: PlatformSettingsService;
  let prisma: {
    platformSettings: {
      upsert: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    deliveryTariff: { count: jest.Mock };
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    prisma = {
      platformSettings: {
        upsert: jest.fn().mockResolvedValue(row()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(row({ updatedAt: WRITTEN_AT })),
          ),
      },
      deliveryTariff: { count: jest.fn().mockResolvedValue(1) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformSettingsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(PlatformSettingsService);
  });

  afterEach(() => jest.useRealTimers());

  describe('lecture (cache 60 s)', () => {
    it('lit la ligne singleton et la met en cache (2ᵉ appel sans requête DB)', async () => {
      await service.getSettings();
      await service.getSettings();
      expect(prisma.platformSettings.upsert).toHaveBeenCalledTimes(1);
    });

    it('refait la requête après expiration du TTL (60 s)', async () => {
      await service.getSettings();
      jest.advanceTimersByTime(61_000);
      await service.getSettings();
      expect(prisma.platformSettings.upsert).toHaveBeenCalledTimes(2);
    });

    it('déduplique les cache-miss concurrents en une seule requête', async () => {
      await Promise.all([
        service.getSettings(),
        service.getSettings(),
        service.getSettings(),
      ]);
      expect(prisma.platformSettings.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('écriture', () => {
    it('vide le cache — la lecture suivante refait la requête', async () => {
      await service.getSettings();
      await service.updateSettings({ maintenanceMessage: MSG });
      await service.getSettings();
      // getSettings + lecture fraîche de l'update + getSettings après invalidation
      expect(prisma.platformSettings.upsert).toHaveBeenCalledTimes(3);
    });

    it("lit l'état en base, jamais le cache, avant d'écrire", async () => {
      await service.getSettings(); // met en cache
      await service.updateSettings({ maintenanceMessage: MSG });
      expect(prisma.platformSettings.upsert).toHaveBeenCalledTimes(2);
    });

    it("écrit sous condition de l'updatedAt lu, et seulement les champs envoyés", async () => {
      await service.updateSettings({ maintenanceMessage: MSG });
      expect(prisma.platformSettings.updateMany).toHaveBeenCalledWith({
        where: { id: 'singleton', updatedAt: LOADED_AT },
        data: { maintenanceMessage: MSG },
      });
    });

    it('retourne l’avant (lecture fraîche) et l’après (relu)', async () => {
      const { before, after } = await service.updateSettings({
        maintenanceMessage: MSG,
      });
      expect(before.updatedAt).toEqual(LOADED_AT);
      expect(after.updatedAt).toEqual(WRITTEN_AT);
    });

    it("un PATCH vide n'écrit rien (updatedAt n'avance pas)", async () => {
      await service.updateSettings({});
      expect(prisma.platformSettings.updateMany).not.toHaveBeenCalled();
    });

    it('null est transmis : il efface la colonne', async () => {
      await service.updateSettings({ minAppVersion: null });
      expect(prisma.platformSettings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { minAppVersion: null } }),
      );
    });

    it("expectedUpdatedAt n'est jamais écrit en base", async () => {
      await service.updateSettings({
        maintenanceMessage: MSG,
        expectedUpdatedAt: LOADED_AT.toISOString(),
      });
      const { data } = prisma.platformSettings.updateMany.mock.calls[0][0];
      expect(data).not.toHaveProperty('expectedUpdatedAt');
    });
  });

  describe('verrou optimiste (SET-001)', () => {
    it("accepte l'écriture quand expectedUpdatedAt correspond", async () => {
      await expect(
        service.updateSettings({
          maintenanceMessage: MSG,
          expectedUpdatedAt: LOADED_AT.toISOString(),
        }),
      ).resolves.toBeDefined();
    });

    it('409 si la configuration a bougé depuis le chargement du formulaire', async () => {
      await expect(
        service.updateSettings({
          maintenanceMessage: MSG,
          expectedUpdatedAt: '2026-09-22T09:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.platformSettings.updateMany).not.toHaveBeenCalled();
    });

    it("409 si un autre administrateur écrit entre la lecture et l'écriture", async () => {
      prisma.platformSettings.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.updateSettings({ maintenanceMessage: MSG }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('le verrou perdu porte le code SETTINGS_STALE (seul signal de « rechargez »)', async () => {
      const error = await service
        .updateSettings({
          maintenanceMessage: MSG,
          expectedUpdatedAt: '2026-09-22T09:00:00.000Z',
        })
        .catch((e: ConflictException) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'SETTINGS_STALE',
      });
    });

    it("n'invalide pas le cache sur un 409", async () => {
      await service.getSettings();
      prisma.platformSettings.updateMany.mockResolvedValue({ count: 0 });
      await service.updateSettings({ maintenanceMessage: MSG }).catch(() => {});
      await service.getSettings();
      // getSettings (cache) + lecture fraîche ; la 2ᵉ lecture sert le cache
      expect(prisma.platformSettings.upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('invariants du canal de mise à jour (SET-002)', () => {
    it('refuse min > latest envoyés ensemble', async () => {
      await expect(
        service.updateSettings({
          minAppVersion: '2.0.0',
          latestAppVersion: '1.3.0',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('PATCH partiel : juge min envoyé contre latest déjà en base', async () => {
      // base : latest = 1.3.0
      await expect(
        service.updateSettings({ minAppVersion: '1.4.0' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.platformSettings.updateMany).not.toHaveBeenCalled();
    });

    it('PATCH partiel : refuse de vider latest sous un blocage actif', async () => {
      // base : min = 1.3.0 ; latest → null laisserait un blocage invérifiable
      await expect(
        service.updateSettings({ latestAppVersion: null }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('PATCH partiel : refuse de baisser latest sous le blocage en base', async () => {
      await expect(
        service.updateSettings({ latestAppVersion: '1.2.9' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuse un blocage sans dernière version (base vide)', async () => {
      prisma.platformSettings.upsert.mockResolvedValue(
        row({ minAppVersion: null, latestAppVersion: null }),
      );
      await expect(
        service.updateSettings({ minAppVersion: '1.3.0' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lever le blocage est toujours possible', async () => {
      await expect(
        service.updateSettings({ minAppVersion: null }),
      ).resolves.toBeDefined();
    });

    it('lever le blocage et la dernière version ensemble est possible', async () => {
      await expect(
        service.updateSettings({ minAppVersion: null, latestAppVersion: null }),
      ).resolves.toBeDefined();
    });

    it('accepte une montée cohérente des deux seuils', async () => {
      await expect(
        service.updateSettings({
          minAppVersion: '1.3.1',
          latestAppVersion: '1.3.1',
        }),
      ).resolves.toBeDefined();
    });

    it("ne juge pas les versions quand le PATCH n'y touche pas", async () => {
      // État hérité incohérent en base : il ne doit pas empêcher de poser
      // un message de maintenance en urgence.
      prisma.platformSettings.upsert.mockResolvedValue(
        row({ minAppVersion: '2.0.0', latestAppVersion: null }),
      );
      await expect(
        service.updateSettings({ maintenanceMessage: MSG }),
      ).resolves.toBeDefined();
    });
  });

  /**
   * R-09 — un réglage qui fixe de l'argent ne passe plus par le PATCH : il se
   * demande, et un second administrateur l'approuve (`financial-change`).
   */
  describe('réglages financiers (R-09)', () => {
    it.each([
      ['serviceFeePercent', 12],
      ['groceryServiceFeeBps', 500],
      ['restaurantCommissionPercent', 8],
      ['loyaltyPointValueXaf', 40],
      ['loyaltyPointsPerOrder', 2],
      ['loyaltyMinRedemption', 10],
      ['referrerBonusPoints', 5],
      ['vendorPayoutAutoEnabled', true],
      ['vendorPayoutDelayMinutes', 30],
      ['deliveryPricingMode', 'PLATFORM'],
    ])(
      '%s modifié → 409 FINANCIAL_SETTING_REQUIRES_APPROVAL',
      async (key, value) => {
        const error = await service
          .updateSettings({ [key]: value })
          .catch((e: ConflictException) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'FINANCIAL_SETTING_REQUIRES_APPROVAL',
          fields: [key],
        });
        expect(prisma.platformSettings.updateMany).not.toHaveBeenCalled();
      },
    );

    it('tout ou rien : le champ non financier du même corps n’est pas écrit', async () => {
      await expect(
        service.updateSettings({
          maintenanceMessage: MSG,
          serviceFeePercent: 12,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.platformSettings.updateMany).not.toHaveBeenCalled();
    });

    it('une valeur financière identique est acceptée mais jamais écrite', async () => {
      // Un formulaire qui renvoie tous ses champs ne doit pas casser — et ne
      // doit pas réécrire une valeur qu'une approbation aurait changée entre-temps.
      await service.updateSettings({
        serviceFeePercent: 15,
        loyaltyPointValueXaf: 50,
        maintenanceMessage: MSG,
      });
      expect(prisma.platformSettings.updateMany).toHaveBeenCalledWith({
        where: { id: 'singleton', updatedAt: LOADED_AT },
        data: { maintenanceMessage: MSG },
      });
    });

    it('seulement des valeurs financières identiques : rien n’est écrit', async () => {
      await service.updateSettings({ serviceFeePercent: 15 });
      expect(prisma.platformSettings.updateMany).not.toHaveBeenCalled();
    });

    it('la bascule de tarification est un geste financier, pas un contrôle de grille', async () => {
      prisma.deliveryTariff.count.mockResolvedValue(0);
      const error = await service
        .updateSettings({ deliveryPricingMode: 'PLATFORM' })
        .catch((e: ConflictException) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'FINANCIAL_SETTING_REQUIRES_APPROVAL',
      });
    });
  });
});
