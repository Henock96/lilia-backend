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
      findMany: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
  };
  let service: RefundsService;

  beforeEach(() => {
    prisma = {
      payment: { findFirst: jest.fn() },
      refund: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
    };
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

    it('reste idempotent si l’annulation est rejouée', async () => {
      // `Refund.orderId` est `@unique` : la base refuse le doublon. Le service
      // doit rendre la ligne existante plutôt que de propager le P2002 —
      // sinon un retour d'annulation ferait échouer toute la requête, alors
      // que la dette est déjà correctement enregistrée.
      prisma.payment.findFirst.mockResolvedValue({ id: 'p-1', amount: 6400 });
      prisma.refund.create.mockRejectedValue(uniqueViolation());
      prisma.refund.findUnique.mockResolvedValue({
        id: 'ref-existant',
        amount: 6400,
      });

      await expect(
        service.openForCancelledOrder({ orderId: 'o-1', reason: 'Rejeu' }),
      ).resolves.toEqual({ id: 'ref-existant', amount: 6400 });
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
});
