import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DeliveryAssignmentOutcome } from '@prisma/client';

import { DeliveryQueryService } from './delivery-query.service';
import { DeliveryAssignmentLogService } from './delivery-assignment-log.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * `GET /deliveries/:id/assignments` — l'historique des mains d'une course.
 *
 * ⚠️ Cette route existe **aussi** pour rendre l'écriture observable. Une table
 * qu'on remplit sans jamais la lire se dégrade en silence : une clôture qui
 * cesserait d'être appelée ne produirait aucun symptôme jusqu'au jour où l'on
 * en a besoin — c'est-à-dire pendant un litige. Ces tests protègent donc deux
 * choses : qui a le droit de lire, et ce que la lecture rend.
 */
describe('DeliveryQueryService.findAssignmentHistory', () => {
  let service: DeliveryQueryService;

  const OWNER_UID = 'fb-owner';
  const AUTRE_UID = 'fb-autre';
  const ADMIN_UID = 'fb-admin';
  const LIVREUR_UID = 'fb-livreur';

  const prisma = {
    delivery: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    deliveryAssignment: { findMany: jest.fn() },
  };

  const T0 = new Date('2026-09-19T10:00:00Z');
  const T1 = new Date('2026-09-19T10:02:30Z'); // +150 s
  const T2 = new Date('2026-09-19T10:20:00Z'); // +1200 s

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma.delivery.findUnique.mockResolvedValue({
      id: 'd1',
      orderId: 'o1',
      order: { restaurant: { owner: { firebaseUid: OWNER_UID } } },
    });
    prisma.user.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(
        {
          [ADMIN_UID]: { role: 'ADMIN' },
          [AUTRE_UID]: { role: 'RESTAURATEUR' },
          [LIVREUR_UID]: { role: 'LIVREUR' },
        }[where.firebaseUid as string] ?? null,
      ),
    );
    prisma.deliveryAssignment.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryQueryService,
        DeliveryAssignmentLogService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(DeliveryQueryService);
  });

  const lire = (uid: string) => service.findAssignmentHistory('d1', uid);

  describe('qui peut lire', () => {
    it('le vendeur propriétaire', async () => {
      await expect(lire(OWNER_UID)).resolves.toBeDefined();
      // Propriétaire reconnu par le uid : aucune lecture de rôle nécessaire.
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('l’ADMIN', async () => {
      await expect(lire(ADMIN_UID)).resolves.toBeDefined();
    });

    /// Un autre vendeur voit la course d'un concurrent : c'est l'IDOR que la
    /// remédiation d'août a fermé ailleurs, et il n'a pas à rouvrir ici.
    it('un autre vendeur : refusé', async () => {
      await expect(lire(AUTRE_UID)).rejects.toBeInstanceOf(ForbiddenException);
    });

    /**
     * Le livreur assigné voit sa mission (`GET /deliveries/:id`), et c'est
     * légitime. Savoir à qui elle a été retirée avant lui, ou à qui elle passe
     * après, ne le regarde pas — et nourrirait une conversation qu'on n'a
     * aucune raison d'ouvrir.
     */
    it('le livreur, même assigné : refusé', async () => {
      await expect(lire(LIVREUR_UID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('livraison inconnue : 404, et aucune lecture du journal', async () => {
      prisma.delivery.findUnique.mockResolvedValue(null);
      await expect(lire(ADMIN_UID)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.deliveryAssignment.findMany).not.toHaveBeenCalled();
    });
  });

  describe('ce que la lecture rend', () => {
    beforeEach(() => {
      prisma.deliveryAssignment.findMany.mockResolvedValue([
        {
          id: 'a1',
          deliverer: { id: 'liv-A', nom: 'A', phone: '061' },
          assignedAt: T0,
          assignedByUserId: 'u-owner',
          assignedByRole: 'RESTAURATEUR',
          acceptedAt: T1,
          pickedUpAt: null,
          releasedAt: T2,
          outcome: DeliveryAssignmentOutcome.REASSIGNED,
          releaseReason: null,
        },
        {
          id: 'a2',
          deliverer: { id: 'liv-B', nom: 'B', phone: '062' },
          assignedAt: T2,
          assignedByUserId: 'u-admin',
          assignedByRole: 'ADMIN',
          acceptedAt: null,
          pickedUpAt: null,
          releasedAt: null,
          outcome: null,
          releaseReason: null,
        },
      ]);
    });

    it('les mains dans le sens du récit, la première d’abord', async () => {
      const { data } = await lire(ADMIN_UID);
      expect(data.map((l) => l.deliverer.id)).toEqual(['liv-A', 'liv-B']);
      expect(
        prisma.deliveryAssignment.findMany.mock.calls[0][0].orderBy,
      ).toEqual({ assignedAt: 'asc' });
    });

    /// Dérivées, jamais stockées : une durée figée en base se désynchronise de
    /// ses bornes à la première correction.
    it('les durées sont calculées depuis les horodatages', async () => {
      const { data } = await lire(ADMIN_UID);
      expect(data[0].durationSeconds).toBe(1200);
      expect(data[0].responseSeconds).toBe(150);
    });

    /// `null` sur la main en cours et sur celle qui n'a jamais répondu : c'est
    /// exactement l'information qu'on cherche sur une course qui a traîné.
    it('une main ouverte n’a pas de durée, une main sans réponse pas de délai', async () => {
      const { data } = await lire(ADMIN_UID);
      expect(data[1].durationSeconds).toBeNull();
      expect(data[1].responseSeconds).toBeNull();
    });

    it('compte les changements de mains, pas les mains', async () => {
      const { meta } = await lire(ADMIN_UID);
      expect(meta.handoverCount).toBe(1);
      expect(meta.orderId).toBe('o1');
    });

    it('une course jamais assignée : zéro changement, pas -1', async () => {
      prisma.deliveryAssignment.findMany.mockResolvedValue([]);
      const { data, meta } = await lire(ADMIN_UID);
      expect(data).toEqual([]);
      expect(meta.handoverCount).toBe(0);
    });

    it('qui a réassigné est nommé', async () => {
      const { data } = await lire(ADMIN_UID);
      expect(data[1].assignedByUserId).toBe('u-admin');
      expect(data[1].assignedByRole).toBe('ADMIN');
    });
  });
});
