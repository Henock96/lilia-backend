import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { DeliveryReviewsService } from './delivery-reviews.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Notation du livreur.
 *
 * Les quatre règles métier sont testées ici et portées en base :
 * client propriétaire, livraison terminée, une seule note, livreur réel.
 */
describe('DeliveryReviewsService', () => {
  let service: DeliveryReviewsService;

  const prisma = {
    user: { findUnique: jest.fn() },
    delivery: { findUnique: jest.fn() },
    deliveryReview: {
      create: jest.fn(),
      groupBy: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  const delivered = {
    id: 'd1',
    status: 'LIVRER',
    orderId: 'o1',
    delivererId: 'liv1',
    order: { userId: 'c1' },
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma.user.findUnique.mockResolvedValue({ id: 'c1', role: 'CLIENT' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryReviewsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(DeliveryReviewsService);
  });

  const dto = { deliveryId: 'd1', rating: 5, comment: 'Rapide et souriant' };

  describe('create', () => {
    it('enregistre la note sur une livraison terminée', async () => {
      prisma.delivery.findUnique.mockResolvedValue(delivered);
      prisma.deliveryReview.create.mockResolvedValue({ id: 'r1', rating: 5 });

      const res = await service.create(dto, 'uid-c1');

      expect(prisma.deliveryReview.create).toHaveBeenCalledWith({
        data: {
          deliveryId: 'd1',
          orderId: 'o1',
          // Le livreur vient de la livraison, jamais du client : sinon on
          // pourrait noter quelqu'un qui n'a pas fait la course.
          delivererId: 'liv1',
          userId: 'c1',
          rating: 5,
          comment: 'Rapide et souriant',
        },
      });
      expect(res.data).toEqual({ id: 'r1', rating: 5 });
    });

    it('refuse un client qui n’est pas le destinataire de la commande', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'autre', role: 'CLIENT' });
      prisma.delivery.findUnique.mockResolvedValue(delivered);

      await expect(service.create(dto, 'uid-autre')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.deliveryReview.create).not.toHaveBeenCalled();
    });

    it.each(['ASSIGNER', 'ACCEPTER', 'EN_TRANSIT', 'ECHEC'])(
      'refuse la notation tant que la livraison est %s',
      async (status) => {
        prisma.delivery.findUnique.mockResolvedValue({ ...delivered, status });

        await expect(service.create(dto, 'uid-c1')).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(prisma.deliveryReview.create).not.toHaveBeenCalled();
      },
    );

    it('double notation : 409 porté par la contrainte d’unicité', async () => {
      prisma.delivery.findUnique.mockResolvedValue(delivered);
      prisma.deliveryReview.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.10.0',
        }),
      );

      await expect(service.create(dto, 'uid-c1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('livraison introuvable → 404', async () => {
      prisma.delivery.findUnique.mockResolvedValue(null);
      await expect(service.create(dto, 'uid-c1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('livraison sans livreur rattaché → 400', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        ...delivered,
        delivererId: null,
      });
      await expect(service.create(dto, 'uid-c1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('getDelivererStats', () => {
    it('agrège moyenne et distribution côté base', async () => {
      prisma.deliveryReview.groupBy.mockResolvedValue([
        { rating: 5, _count: { rating: 3 } },
        { rating: 4, _count: { rating: 1 } },
      ]);

      const res = await service.getDelivererStats('liv1');

      expect(res.data.totalReviews).toBe(4);
      expect(res.data.averageRating).toBe(4.8); // (5*3 + 4) / 4 = 4.75 → 4.8
      expect(res.data.ratingDistribution[5]).toBe(3);
      expect(res.data.ratingDistribution[1]).toBe(0);
    });

    it('livreur sans note : moyenne null, pas 0', async () => {
      prisma.deliveryReview.groupBy.mockResolvedValue([]);
      const res = await service.getDelivererStats('liv1');
      // `null` et `0` ne disent pas la même chose : « pas encore noté » n'est
      // pas « très mal noté ».
      expect(res.data.averageRating).toBeNull();
      expect(res.data.totalReviews).toBe(0);
    });
  });

  describe('findMine', () => {
    it('ne renvoie pas l’identité du client au livreur', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'liv1', role: 'LIVREUR' });
      prisma.deliveryReview.findMany.mockResolvedValue([]);
      prisma.deliveryReview.count.mockResolvedValue(0);

      await service.findMine('uid-liv1');

      const select = prisma.deliveryReview.findMany.mock.calls[0][0].select;
      expect(select.userId).toBeUndefined();
      expect(select.user).toBeUndefined();
      expect(select.rating).toBe(true);
    });
  });
});
