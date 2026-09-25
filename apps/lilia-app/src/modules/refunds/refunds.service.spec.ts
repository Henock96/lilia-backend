import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, RefundStatus } from '@prisma/client';

import { RefundsService } from './refunds.service';

/**
 * Remboursements dus après annulation d'une commande payée (fix H5).
 *
 * Ce service est la seule trace d'une dette envers un client. S'il n'ouvre pas
 * de ligne, personne ne saura que de l'argent doit être rendu : il n'y a ni
 * rapprochement bancaire automatique, ni réclamation qui remonte toute seule.
 * D'où l'insistance des tests sur deux points — **ne jamais rater une dette**,
 * et **ne jamais la payer deux fois**.
 *
 * Le module était livré sans aucun test (audit post-correction).
 */
describe('RefundsService', () => {
  let prisma: {
    payment: { findFirst: jest.Mock };
    refund: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      aggregate: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    restaurantPayout: { findUnique: jest.Mock };
    vendorBalanceEntry: { createMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: RefundsService;

  beforeEach(() => {
    prisma = {
      payment: { findFirst: jest.fn() },
      refund: {
        create: jest.fn(),
        findUnique: jest.fn(),
        // Aucun remboursement automatique existant, rien de déjà remboursé.
        findFirst: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
        findMany: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
      // Aucun reversement vendeur par défaut (fix F-04).
      restaurantPayout: { findUnique: jest.fn().mockResolvedValue(null) },
      // F3-07 — dette du vendeur écrite avec la clôture.
      vendorBalanceEntry: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    // La transaction reçoit le client lui-même.
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
    service = new RefundsService(prisma as never);
    // Les avertissements de log polluent la sortie sans rien apprendre.
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  const uniqueViolation = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: '7.0.0',
    });

  describe('openForCancelledOrder', () => {
    it('ouvre une dette pour le montant réellement encaissé', () => {
      // Et non pour le total de la commande : un paiement partiel ou un
      // ajustement rendrait les deux chiffres différents, et c'est l'argent
      // reçu qu'on doit rendre.
      prisma.payment.findFirst.mockResolvedValue({ id: 'p-1', amount: 6400 });
      prisma.refund.create.mockResolvedValue({ id: 'ref-1', amount: 6400 });

      return service
        .openForCancelledOrder({ orderId: 'o-1', reason: 'Annulation admin' })
        .then((result) => {
          expect(result).toEqual({ id: 'ref-1', amount: 6400 });
          expect(prisma.refund.create).toHaveBeenCalledWith(
            expect.objectContaining({
              data: expect.objectContaining({
                amount: 6400,
                paymentId: 'p-1',
                status: RefundStatus.PENDING,
              }),
            }),
          );
        });
    });

    it("n'ouvre rien quand rien n'a été encaissé", async () => {
      // Commande expirée ou annulée avant paiement : créer une ligne à 0
      // encombrerait la file admin d'un travail qui n'existe pas.
      prisma.payment.findFirst.mockResolvedValue(null);

      await expect(
        service.openForCancelledOrder({ orderId: 'o-1', reason: 'Expirée' }),
      ).resolves.toBeNull();
      expect(prisma.refund.create).not.toHaveBeenCalled();
    });

    it("n'ouvre rien sur un paiement à montant nul", async () => {
      // Cas d'une commande réglée intégralement en points de fidélité.
      prisma.payment.findFirst.mockResolvedValue({ id: 'p-1', amount: 0 });

      await expect(
        service.openForCancelledOrder({ orderId: 'o-1', reason: 'Annulée' }),
      ).resolves.toBeNull();
      expect(prisma.refund.create).not.toHaveBeenCalled();
    });

    it('reste idempotent si l’annulation est rejouée en concurrence', async () => {
      // L'index `Refund_orderId_auto_uq` refuse le doublon. Le service doit
      // rendre la ligne existante plutôt que de propager le P2002 — sinon un
      // retour d'annulation ferait échouer toute la requête, alors que la
      // dette est déjà correctement enregistrée.
      prisma.payment.findFirst.mockResolvedValue({ id: 'p-1', amount: 6400 });
      prisma.refund.create.mockRejectedValue(uniqueViolation());
      prisma.refund.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'ref-existant', amount: 6400 });

      await expect(
        service.openForCancelledOrder({ orderId: 'o-1', reason: 'Rejeu' }),
      ).resolves.toEqual({ id: 'ref-existant', amount: 6400 });
    });

    it('F3-06 — un rejeu après un remboursement DÉJÀ VERSÉ n’en rouvre pas', async () => {
      // `@@unique([orderId])` ne protège plus rien : la contrainte est devenue
      // partielle. Sans la recherche du remboursement automatique, l'outbox
      // rejouée après un `COMPLETED` rembourserait le client une seconde fois.
      prisma.refund.findFirst.mockResolvedValue({ id: 'ref-1', amount: 6400 });

      await expect(
        service.openForCancelledOrder({ orderId: 'o-1', reason: 'Rejeu' }),
      ).resolves.toEqual({ id: 'ref-1', amount: 6400 });
      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(prisma.refund.findFirst.mock.calls[0][0].where).toMatchObject({
        orderId: 'o-1',
        reasonCode: {
          in: [
            'ORDER_CANCELLED',
            'VENDOR_REJECTED',
            'VENDOR_TIMEOUT',
            'DELIVERY_FAILED',
          ],
        },
      });
    });

    it('F3-06 — rembourse le reliquat, pas l’encaissement entier', async () => {
      prisma.payment.findFirst.mockResolvedValue({ id: 'p-1', amount: 6400 });
      prisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 1500 } });
      prisma.refund.create.mockResolvedValue({ id: 'ref-2', amount: 4900 });

      await service.openForCancelledOrder({
        orderId: 'o-1',
        reason: 'Refus vendeur',
        reasonCode: 'VENDOR_REJECTED',
      });
      expect(prisma.refund.create.mock.calls[0][0].data).toMatchObject({
        amount: 4900,
        reasonCode: 'VENDOR_REJECTED',
      });
    });

    it('laisse remonter une erreur base qui n’est pas un doublon', async () => {
      // Avaler une panne de base ici reviendrait à perdre silencieusement une
      // dette : mieux vaut faire échouer l'annulation et la rejouer.
      prisma.payment.findFirst.mockResolvedValue({ id: 'p-1', amount: 6400 });
      prisma.refund.create.mockRejectedValue(new Error('connexion perdue'));

      await expect(
        service.openForCancelledOrder({ orderId: 'o-1', reason: 'Panne' }),
      ).rejects.toThrow('connexion perdue');
    });
  });

  describe('updateStatus', () => {
    const pending = {
      id: 'ref-1',
      status: RefundStatus.PENDING,
      notes: null,
      processedAt: null,
    };

    it('fait avancer une ligne ouverte et horodate la clôture', async () => {
      prisma.refund.findUnique
        .mockResolvedValueOnce(pending)
        .mockResolvedValue({ ...pending, status: RefundStatus.COMPLETED });
      prisma.refund.updateMany.mockResolvedValue({ count: 1 });

      await service.updateStatus(
        'ref-1',
        RefundStatus.COMPLETED,
        'admin-1',
        'Virement effectué',
      );

      const write = prisma.refund.updateMany.mock.calls[0][0];
      expect(write.data.status).toBe(RefundStatus.COMPLETED);
      expect(write.data.processedBy).toBe('admin-1');
      expect(write.data.processedAt).toBeInstanceOf(Date);
      // Verrou optimiste : l'écriture est conditionnée sur l'état lu.
      expect(write.where).toEqual({
        id: 'ref-1',
        status: RefundStatus.PENDING,
      });
    });

    it("n'horodate pas un simple passage en cours de traitement", async () => {
      // `processedAt` marque la clôture. Le poser sur `PROCESSING` ferait
      // croire à un remboursement effectué alors que le virement n'est pas
      // parti.
      prisma.refund.findUnique
        .mockResolvedValueOnce(pending)
        .mockResolvedValue({ ...pending, status: RefundStatus.PROCESSING });
      prisma.refund.updateMany.mockResolvedValue({ count: 1 });

      await service.updateStatus('ref-1', RefundStatus.PROCESSING, 'admin-1');

      expect(prisma.refund.updateMany.mock.calls[0][0].data.processedAt).toBe(
        null,
      );
    });

    it('refuse de rouvrir un remboursement déjà clos', async () => {
      // Le risque concret est le double virement : deux admins qui ouvrent la
      // même fiche, l'un traite, l'autre valide sans recharger.
      prisma.refund.findUnique.mockResolvedValue({
        ...pending,
        status: RefundStatus.COMPLETED,
      });

      await expect(
        service.updateStatus('ref-1', RefundStatus.PROCESSING, 'admin-2'),
      ).rejects.toThrow(ConflictException);
      expect(prisma.refund.updateMany).not.toHaveBeenCalled();
    });

    it('détecte une modification concurrente entre la lecture et l’écriture', async () => {
      // La fenêtre que le verrou optimiste couvre : les deux admins lisent
      // `PENDING`, le premier écrit, le second doit être rejeté.
      prisma.refund.findUnique.mockResolvedValue(pending);
      prisma.refund.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.updateStatus('ref-1', RefundStatus.COMPLETED, 'admin-2'),
      ).rejects.toThrow(ConflictException);
    });

    it('signale une fiche inexistante', async () => {
      prisma.refund.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStatus('inconnu', RefundStatus.COMPLETED, 'admin-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('list', () => {
    it('sert la file du plus ancien au plus récent, avec le total', async () => {
      // C'est une file d'attente, pas un flux d'actualité : le client qui
      // patiente depuis le plus longtemps passe en premier. Et `total` doit
      // porter le décompte complet, sinon le badge admin plafonne à une page.
      prisma.refund.findMany.mockResolvedValue([{ id: 'ref-1' }]);
      prisma.refund.count.mockResolvedValue(57);

      const result = await service.list({ status: RefundStatus.PENDING });

      expect(prisma.refund.findMany.mock.calls[0][0].orderBy).toEqual({
        createdAt: 'asc',
      });
      expect(result.meta.total).toBe(57);
    });

    it('borne la page demandée', async () => {
      prisma.refund.findMany.mockResolvedValue([]);
      prisma.refund.count.mockResolvedValue(0);

      await service.list({ page: 3, limit: 20 });

      const query = prisma.refund.findMany.mock.calls[0][0];
      expect(query.skip).toBe(40);
      expect(query.take).toBe(20);
    });
  });

  describe('clôture manuelle et reversement vendeur (F-04)', () => {
    const open = {
      id: 'r1',
      orderId: 'o1',
      status: RefundStatus.PENDING,
      reasonCode: 'ORDER_CANCELLED',
      bearer: 'PLATFORM',
      notes: null,
      processedAt: null,
    };

    it('refuse de clôturer « remboursé » pendant un reversement PENDING', async () => {
      prisma.refund.findUnique.mockResolvedValue(open);
      prisma.restaurantPayout.findUnique.mockResolvedValue({
        status: 'PENDING',
      });
      await expect(
        service.updateStatus('r1', RefundStatus.COMPLETED, 'admin-1'),
      ).rejects.toThrow(/reversement au vendeur est en cours/);
      expect(prisma.refund.updateMany).not.toHaveBeenCalled();
    });

    it('autorise la clôture manuelle après un reversement SUCCESS (issue d’arbitrage)', async () => {
      prisma.refund.findUnique.mockResolvedValue(open);
      prisma.restaurantPayout.findUnique.mockResolvedValue({
        status: 'SUCCESS',
      });
      prisma.refund.updateMany.mockResolvedValue({ count: 1 });
      await service.updateStatus('r1', RefundStatus.COMPLETED, 'admin-1');
      expect(prisma.refund.updateMany).toHaveBeenCalled();
    });

    it('F3-06 — un geste de la plateforme ne consulte pas le reversement (R-06.5)', async () => {
      prisma.refund.findUnique.mockResolvedValue({
        ...open,
        reasonCode: 'GOODWILL',
        bearer: 'PLATFORM',
      });
      prisma.refund.updateMany.mockResolvedValue({ count: 1 });
      await service.updateStatus('r1', RefundStatus.COMPLETED, 'admin-1');
      expect(prisma.restaurantPayout.findUnique).not.toHaveBeenCalled();
    });

    it('F3-07 — remboursement à la charge du vendeur déjà payé : clôturé, et sa dette écrite', async () => {
      prisma.refund.findUnique.mockResolvedValue({
        ...open,
        amount: 1500,
        reasonCode: 'MISSING_ITEM',
        bearer: 'VENDOR',
      });
      prisma.restaurantPayout.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'SUCCESS',
        restaurantId: 'r1',
      });
      prisma.refund.updateMany.mockResolvedValue({ count: 1 });
      await service.updateStatus('r1', RefundStatus.COMPLETED, 'admin-1');
      expect(prisma.vendorBalanceEntry.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            restaurantId: 'r1',
            kind: 'REFUND_CLAWBACK',
            amountXaf: -1500,
            refundId: 'r1',
          }),
          skipDuplicates: true,
        }),
      );
    });

    it('un refus (REJECTED) ne consulte pas le reversement', async () => {
      prisma.refund.findUnique.mockResolvedValue(open);
      prisma.refund.updateMany.mockResolvedValue({ count: 1 });
      await service.updateStatus('r1', RefundStatus.REJECTED, 'admin-1');
      expect(prisma.restaurantPayout.findUnique).not.toHaveBeenCalled();
    });
  });
});
