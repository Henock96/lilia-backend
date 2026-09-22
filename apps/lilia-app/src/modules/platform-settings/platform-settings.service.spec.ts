import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PlatformSettingsService } from './platform-settings.service';
import { PrismaService } from '../../prisma/prisma.service';

const LOADED_AT = new Date('2026-09-22T10:00:00.000Z');
const WRITTEN_AT = new Date('2026-09-22T10:05:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'singleton',
    serviceFeePercent: 15,
    restaurantCommissionPercent: 10,
    loyaltyPointsPerOrder: 1,
    loyaltyPointValueXaf: 50,
    loyaltyMinRedemption: 1,
    referrerBonusPoints: 1,
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
      await service.updateSettings({ serviceFeePercent: 10 });
      await service.getSettings();
      // getSettings + lecture fraîche de l'update + getSettings après invalidation
      expect(prisma.platformSettings.upsert).toHaveBeenCalledTimes(3);
    });

    it("lit l'état en base, jamais le cache, avant d'écrire", async () => {
      await service.getSettings(); // met en cache
      await service.updateSettings({ serviceFeePercent: 10 });
      expect(prisma.platformSettings.upsert).toHaveBeenCalledTimes(2);
    });

    it("écrit sous condition de l'updatedAt lu, et seulement les champs envoyés", async () => {
      await service.updateSettings({ serviceFeePercent: 12 });
      expect(prisma.platformSettings.updateMany).toHaveBeenCalledWith({
        where: { id: 'singleton', updatedAt: LOADED_AT },
        data: { serviceFeePercent: 12 },
      });
    });

    it('retourne l’avant (lecture fraîche) et l’après (relu)', async () => {
      const { before, after } = await service.updateSettings({
        serviceFeePercent: 12,
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
        serviceFeePercent: 12,
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
          serviceFeePercent: 12,
          expectedUpdatedAt: LOADED_AT.toISOString(),
        }),
      ).resolves.toBeDefined();
    });

    it('409 si la configuration a bougé depuis le chargement du formulaire', async () => {
      await expect(
        service.updateSettings({
          serviceFeePercent: 12,
          expectedUpdatedAt: '2026-09-22T09:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.platformSettings.updateMany).not.toHaveBeenCalled();
    });

    it("409 si un autre administrateur écrit entre la lecture et l'écriture", async () => {
      prisma.platformSettings.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.updateSettings({ serviceFeePercent: 12 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("n'invalide pas le cache sur un 409", async () => {
      await service.getSettings();
      prisma.platformSettings.updateMany.mockResolvedValue({ count: 0 });
      await service.updateSettings({ serviceFeePercent: 12 }).catch(() => {});
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
      // État hérité incohérent en base : il ne doit pas empêcher de changer
      // les frais de service en urgence.
      prisma.platformSettings.upsert.mockResolvedValue(
        row({ minAppVersion: '2.0.0', latestAppVersion: null }),
      );
      await expect(
        service.updateSettings({ serviceFeePercent: 12 }),
      ).resolves.toBeDefined();
    });
  });
});
