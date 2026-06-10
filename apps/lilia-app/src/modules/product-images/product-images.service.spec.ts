import { Test } from '@nestjs/testing';
import { ProductImagesService } from './product-images.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PhotosCommonService } from '../photos-common/photos-common.service';

describe('ProductImagesService — sync Product.imageUrl', () => {
  let service: ProductImagesService;
  let tx: {
    productImage: { create: jest.Mock; update: jest.Mock; delete: jest.Mock; findFirst: jest.Mock };
    product: { update: jest.Mock };
  };
  let prisma: {
    product: { findUnique: jest.Mock };
    productImage: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let common: { assertRestaurantOwnership: jest.Mock; assertUnderMax: jest.Mock; demoteOtherCovers: jest.Mock; cleanupCloudinary: jest.Mock };

  const ADMIN = { id: 'admin-1', role: 'ADMIN' };

  beforeEach(async () => {
    tx = {
      productImage: { create: jest.fn(), update: jest.fn(), delete: jest.fn(), findFirst: jest.fn() },
      product: { update: jest.fn() },
    };
    prisma = {
      product: { findUnique: jest.fn().mockResolvedValue({ restaurantId: 'resto-1' }) },
      productImage: { findUnique: jest.fn() },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    common = {
      assertRestaurantOwnership: jest.fn().mockResolvedValue(undefined),
      assertUnderMax: jest.fn().mockResolvedValue(undefined),
      demoteOtherCovers: jest.fn().mockResolvedValue(undefined),
      cleanupCloudinary: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductImagesService,
        { provide: PrismaService, useValue: prisma },
        { provide: PhotosCommonService, useValue: common },
      ],
    }).compile();
    service = moduleRef.get(ProductImagesService);
  });

  it('create(isCover=true) écrit Product.imageUrl = url de l\'image', async () => {
    tx.productImage.create.mockResolvedValue({ id: 'img-1', productId: 'p-1', url: 'http://c/cover.jpg', isCover: true });
    await service.create(
      { productId: 'p-1', url: 'http://c/cover.jpg', isCover: true } as never,
      ADMIN,
    );
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'p-1' }, data: { imageUrl: 'http://c/cover.jpg' } });
  });

  it('create(isCover=false) ne touche pas Product.imageUrl', async () => {
    tx.productImage.create.mockResolvedValue({ id: 'img-2', productId: 'p-1', url: 'http://c/x.jpg', isCover: false });
    await service.create(
      { productId: 'p-1', url: 'http://c/x.jpg', isCover: false } as never,
      ADMIN,
    );
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it('update(isCover=true) synchronise Product.imageUrl', async () => {
    prisma.productImage.findUnique.mockResolvedValue({ id: 'img-3', productId: 'p-1', url: 'http://c/new.jpg' });
    tx.productImage.update.mockResolvedValue({ id: 'img-3', productId: 'p-1', url: 'http://c/new.jpg', isCover: true });
    await service.update('img-3', { isCover: true } as never, ADMIN);
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'p-1' }, data: { imageUrl: 'http://c/new.jpg' } });
  });

  it('remove(cover) promeut la suivante et met à jour imageUrl', async () => {
    prisma.productImage.findUnique.mockResolvedValue({ id: 'img-cover', productId: 'p-1', url: 'http://c/old.jpg', isCover: true, publicId: 'pid' });
    tx.productImage.findFirst.mockResolvedValue({ id: 'img-next', productId: 'p-1', url: 'http://c/next.jpg' });
    await service.remove('img-cover', ADMIN);
    expect(tx.productImage.update).toHaveBeenCalledWith({ where: { id: 'img-next' }, data: { isCover: true } });
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'p-1' }, data: { imageUrl: 'http://c/next.jpg' } });
  });

  it('remove(cover) sans image restante vide imageUrl', async () => {
    prisma.productImage.findUnique.mockResolvedValue({ id: 'img-cover', productId: 'p-1', url: 'http://c/old.jpg', isCover: true, publicId: 'pid' });
    tx.productImage.findFirst.mockResolvedValue(null);
    await service.remove('img-cover', ADMIN);
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'p-1' }, data: { imageUrl: null } });
  });

  it('remove(non-cover) ne touche pas Product.imageUrl', async () => {
    prisma.productImage.findUnique.mockResolvedValue({ id: 'img-x', productId: 'p-1', url: 'http://c/x.jpg', isCover: false, publicId: 'pid' });
    await service.remove('img-x', ADMIN);
    expect(tx.product.update).not.toHaveBeenCalled();
  });
});
