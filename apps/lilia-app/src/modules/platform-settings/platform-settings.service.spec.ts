import { Test, TestingModule } from '@nestjs/testing';
import { PlatformSettingsService } from './platform-settings.service';
import { PrismaService } from '../../prisma/prisma.service';

const ROW = {
  id: 'singleton',
  serviceFeePercent: 8,
  loyaltyPointsPer100Xaf: 1,
  loyaltyPointValueXaf: 5,
  loyaltyMinRedemption: 100,
  referrerBonusPoints: 500,
  referredBonusPoints: 200,
  maintenanceMode: false,
  maintenanceMessage: null,
  updatedAt: new Date(),
};

describe('PlatformSettingsService', () => {
  let service: PlatformSettingsService;
  let prisma: { platformSettings: { upsert: jest.Mock } };

  beforeEach(async () => {
    jest.useFakeTimers();
    prisma = { platformSettings: { upsert: jest.fn().mockResolvedValue(ROW) } };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformSettingsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(PlatformSettingsService);
  });

  afterEach(() => jest.useRealTimers());

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

  it('updateSettings vide le cache — la lecture suivante refait la requête', async () => {
    await service.getSettings();
    await service.updateSettings({ serviceFeePercent: 10 });
    await service.getSettings();
    // 1er getSettings + updateSettings + getSettings après invalidation = 3 upserts
    expect(prisma.platformSettings.upsert).toHaveBeenCalledTimes(3);
  });
});
