/* eslint-disable prettier/prettier */
import { Test, TestingModule } from '@nestjs/testing';
import { getRedisConnectionToken } from '@nestjs-modules/ioredis';
import { User } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { UserCacheService } from './user-cache.service';

describe('UserCacheService', () => {
  let service: UserCacheService;
  let redis: { get: jest.Mock; setex: jest.Mock; del: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };

  const sampleUser: User = {
    id: 'user-123',
    firebaseUid: 'fb-abc',
    email: 'test@example.com',
    role: 'CLIENT',
    nom: 'Test',
    phone: '+242000000',
    imageUrl: null,
    referralCode: 'ABCD1234',
    referredByCode: null,
    referralRewarded: false,
    loyaltyPoints: 0,
    statusUser: 'ACTIVE',
    driverStatus: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
    lastLogin: new Date('2026-05-01T00:00:00Z'),
  } as unknown as User;

  beforeEach(async () => {
    redis = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
    };
    prisma = {
      user: { findUnique: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserCacheService,
        { provide: getRedisConnectionToken(), useValue: redis },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<UserCacheService>(UserCacheService);
  });

  describe('getByFirebaseUid', () => {
    it('renvoie le user depuis le cache si présent (HIT)', async () => {
      redis.get.mockResolvedValue(JSON.stringify(sampleUser));

      const result = await service.getByFirebaseUid('fb-abc');

      expect(result).toMatchObject({ id: 'user-123', role: 'CLIENT' });
      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(redis.get).toHaveBeenCalledWith('user:fbuid:fb-abc');
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('fetch Prisma + cache si miss (MISS)', async () => {
      redis.get.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(sampleUser);

      const result = await service.getByFirebaseUid('fb-abc');

      expect(result).toBe(sampleUser);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { firebaseUid: 'fb-abc' },
      });
      expect(redis.setex).toHaveBeenCalledWith(
        'user:fbuid:fb-abc',
        300,
        expect.any(String),
      );
    });

    it('ne cache rien si Prisma retourne null', async () => {
      redis.get.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.getByFirebaseUid('fb-inconnu');

      expect(result).toBeNull();
      expect(redis.setex).not.toHaveBeenCalled();
    });

    it('fallback Prisma silencieusement si Redis GET plante', async () => {
      redis.get.mockRejectedValue(new Error('connection refused'));
      prisma.user.findUnique.mockResolvedValue(sampleUser);

      const result = await service.getByFirebaseUid('fb-abc');

      expect(result).toBe(sampleUser);
      expect(prisma.user.findUnique).toHaveBeenCalled();
    });

    it('continue même si Redis SETEX plante', async () => {
      redis.get.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(sampleUser);
      redis.setex.mockRejectedValue(new Error('write failed'));

      const result = await service.getByFirebaseUid('fb-abc');

      expect(result).toBe(sampleUser);
    });
  });

  describe('invalidate', () => {
    it('supprime la clé Redis correspondante', async () => {
      redis.del.mockResolvedValue(1);

      await service.invalidate('fb-abc');

      expect(redis.del).toHaveBeenCalledWith('user:fbuid:fb-abc');
    });

    it('ne plante pas si firebaseUid est vide', async () => {
      await expect(service.invalidate('')).resolves.toBeUndefined();
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('avale silencieusement les erreurs Redis', async () => {
      redis.del.mockRejectedValue(new Error('redis down'));
      await expect(service.invalidate('fb-abc')).resolves.toBeUndefined();
    });
  });
});
