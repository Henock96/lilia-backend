/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PhotosCommonService, MAX_PHOTOS_PER_ENTITY } from './photos-common.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';

/**
 * Tests unitaires PhotosCommonService.
 * Prisma + Cloudinary mockés au minimum nécessaire à chaque cas.
 */
describe('PhotosCommonService', () => {
  let service: PhotosCommonService;
  let prismaMock: any;
  let cloudinaryMock: any;

  beforeEach(() => {
    prismaMock = {
      restaurant: { findUnique: jest.fn() },
      vendorPhoto: { count: jest.fn(), updateMany: jest.fn() },
      productImage: { count: jest.fn(), updateMany: jest.fn() },
      menuImage: { count: jest.fn(), updateMany: jest.fn() },
    };
    cloudinaryMock = { deleteImage: jest.fn() };
    service = new PhotosCommonService(
      prismaMock as PrismaService,
      cloudinaryMock as CloudinaryService,
    );
  });

  describe('assertRestaurantOwnership', () => {
    it('no-op si user.role === ADMIN', async () => {
      await service.assertRestaurantOwnership('r_1', { id: 'u_admin', role: 'ADMIN' });
      expect(prismaMock.restaurant.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFound si restaurant inconnu', async () => {
      prismaMock.restaurant.findUnique.mockResolvedValue(null);
      await expect(
        service.assertRestaurantOwnership('r_missing', { id: 'u_1', role: 'RESTAURATEUR' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws Forbidden si owner différent', async () => {
      prismaMock.restaurant.findUnique.mockResolvedValue({ ownerId: 'u_other' });
      await expect(
        service.assertRestaurantOwnership('r_1', { id: 'u_1', role: 'RESTAURATEUR' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('no-op si owner === user.id', async () => {
      prismaMock.restaurant.findUnique.mockResolvedValue({ ownerId: 'u_1' });
      await expect(
        service.assertRestaurantOwnership('r_1', { id: 'u_1', role: 'RESTAURATEUR' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertUnderMax', () => {
    it('no-op si count < MAX', async () => {
      prismaMock.vendorPhoto.count.mockResolvedValue(MAX_PHOTOS_PER_ENTITY - 1);
      await expect(
        service.assertUnderMax('vendorPhoto', { restaurantId: 'r_1' }),
      ).resolves.toBeUndefined();
    });

    it('throws BadRequest si count >= MAX', async () => {
      prismaMock.vendorPhoto.count.mockResolvedValue(MAX_PHOTOS_PER_ENTITY);
      await expect(
        service.assertUnderMax('vendorPhoto', { restaurantId: 'r_1' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('demoteOtherCovers', () => {
    it('met isCover=false sur autres photos de l\'entité (avec keepId)', async () => {
      await service.demoteOtherCovers('vendorPhoto', { restaurantId: 'r_1' }, 'photo_keep');
      expect(prismaMock.vendorPhoto.updateMany).toHaveBeenCalledWith({
        where: { restaurantId: 'r_1', NOT: { id: 'photo_keep' }, isCover: true },
        data: { isCover: false },
      });
    });

    it('met isCover=false sur toutes les photos (sans keepId)', async () => {
      await service.demoteOtherCovers('vendorPhoto', { restaurantId: 'r_1' }, null);
      expect(prismaMock.vendorPhoto.updateMany).toHaveBeenCalledWith({
        where: { restaurantId: 'r_1', isCover: true },
        data: { isCover: false },
      });
    });
  });

  describe('cleanupCloudinary', () => {
    it('no-op si publicId est null', async () => {
      await service.cleanupCloudinary(null);
      expect(cloudinaryMock.deleteImage).not.toHaveBeenCalled();
    });

    it('no-op si publicId est undefined', async () => {
      await service.cleanupCloudinary(undefined);
      expect(cloudinaryMock.deleteImage).not.toHaveBeenCalled();
    });

    it('appelle deleteImage si publicId présent', async () => {
      cloudinaryMock.deleteImage.mockResolvedValue(undefined);
      await service.cleanupCloudinary('lilia-food/restaurants/abc123');
      expect(cloudinaryMock.deleteImage).toHaveBeenCalledWith('lilia-food/restaurants/abc123');
    });

    it('avale silencieusement les erreurs Cloudinary', async () => {
      cloudinaryMock.deleteImage.mockRejectedValue(new Error('Cloudinary down'));
      await expect(
        service.cleanupCloudinary('lilia-food/restaurants/abc123'),
      ).resolves.toBeUndefined();
    });
  });
});
