import { ConflictException } from '@nestjs/common';

import { OrderTransitionService } from './order-transition.service';
import {
  ORDER_TRANSITION_ACTORS,
  ORDER_TRANSITION_SOURCES,
  actorFromRole,
  sourceFromRole,
} from './order-transition.types';

/**
 * Point d'écriture unique de `Order.status` (P0-4).
 *
 * Ce que ces tests fixent : **le changement de statut et sa ligne d'historique
 * sont un seul geste**. Ni l'un sans l'autre, ni l'un avant l'autre, ni l'un
 * dans une transaction et l'autre hors.
 */
describe('OrderTransitionService', () => {
  let service: OrderTransitionService;
  let tx: {
    order: { updateMany: jest.Mock };
    orderHistory: { create: jest.Mock };
    platformSettings: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    service = new OrderTransitionService();
    tx = {
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      orderHistory: { create: jest.fn().mockResolvedValue({}) },
      // Aucune ligne de réglages = acceptation vendeur non mise en service.
      platformSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    };
  });

  const base = {
    orderId: 'o1',
    actor: 'RESTAURATEUR' as const,
    actorUserId: 'u-vendeur',
    source: 'APP' as const,
  };

  describe('transition valide', () => {
    it('EN_PREPARATION → PRET : le statut change ET une ligne est écrite', async () => {
      await service.transition(tx as never, {
        ...base,
        from: 'EN_PREPARATION',
        to: 'PRET',
      });

      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'EN_PREPARATION' },
        data: { status: 'PRET' },
      });
      expect(tx.orderHistory.create).toHaveBeenCalledTimes(1);
      expect(tx.orderHistory.create.mock.calls[0][0].data).toMatchObject({
        orderId: 'o1',
        fromStatus: 'EN_PREPARATION',
        toStatus: 'PRET',
        actionId: 'RESTAURATEUR',
        actorUserId: 'u-vendeur',
        source: 'APP',
      });
    });

    it('conserve la raison quand l’appelant en fournit une', async () => {
      await service.transition(tx as never, {
        ...base,
        from: 'PRET',
        to: 'ANNULER',
        reason: 'Rupture en cuisine',
      });

      expect(tx.orderHistory.create.mock.calls[0][0].data.reason).toBe(
        'Rupture en cuisine',
      );
    });

    it('écrit les champs annexes AVEC le statut, dans le même updateMany', async () => {
      // `paidAt` doit être posé exactement quand la commande passe `PAYER`.
      // L'écrire dans une seconde requête rouvrirait la fenêtre que le verrou
      // optimiste vient de fermer.
      const paidAt = new Date('2026-09-15T10:00:00Z');
      await service.transition(tx as never, {
        ...base,
        from: 'EN_ATTENTE',
        to: 'PAYER',
        actor: 'SYSTEM',
        actorUserId: null,
        source: 'WEBHOOK',
        data: { paidAt },
      });

      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'EN_ATTENTE' },
        data: { status: 'PAYER', paidAt },
      });
      expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    });

    it('une transition automatique n’invente pas d’auteur', async () => {
      await service.transition(tx as never, {
        ...base,
        from: 'EN_ATTENTE',
        to: 'ANNULER',
        actor: 'SYSTEM',
        actorUserId: undefined,
        source: 'CRON',
      });

      // `null` et non un utilisateur technique : il n'y a personne à nommer,
      // et un faux auteur dans un journal d'audit vaut moins que rien.
      expect(
        tx.orderHistory.create.mock.calls[0][0].data.actorUserId,
      ).toBeNull();
    });
  });

  describe('transition perdue (concurrence)', () => {
    it('409 quand la commande a bougé — et AUCUNE ligne d’historique', async () => {
      tx.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.transition(tx as never, {
          ...base,
          from: 'EN_PREPARATION',
          to: 'PRET',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      // Le point qui compte : pas de ligne pour une transition qui n'a pas eu
      // lieu. Un historique qui enregistre des transitions ratées est pire
      // qu'un historique vide.
      expect(tx.orderHistory.create).not.toHaveBeenCalled();
    });

    it('`tryTransition` rend `moved: false` sans lever, et sans écrire', async () => {
      tx.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.tryTransition(tx as never, {
          ...base,
          from: 'EN_ATTENTE',
          to: 'PAYER',
        }),
      ).resolves.toEqual({ moved: false });

      expect(tx.orderHistory.create).not.toHaveBeenCalled();
    });

    it('rejoué trois fois (webhook + sondage + cron), une seule ligne est écrite', async () => {
      // Le verrou porte la garantie : la première transition consomme l'état
      // `EN_ATTENTE`, les deux suivantes affectent 0 ligne.
      let status = 'EN_ATTENTE';
      tx.order.updateMany.mockImplementation(
        ({
          where,
          data,
        }: {
          where: { status: string };
          data: { status: string };
        }) => {
          if (status !== where.status) return Promise.resolve({ count: 0 });
          status = data.status;
          return Promise.resolve({ count: 1 });
        },
      );

      const attempt = (source: 'WEBHOOK' | 'POLLING' | 'CRON') =>
        service.tryTransition(tx as never, {
          ...base,
          from: 'EN_ATTENTE',
          to: 'PAYER',
          actor: 'SYSTEM',
          source,
        });

      const outcomes = await Promise.all([
        attempt('WEBHOOK'),
        attempt('POLLING'),
        attempt('CRON'),
      ]);

      expect(outcomes.filter((o) => o.moved)).toHaveLength(1);
      expect(tx.orderHistory.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('atomicité', () => {
    it('si l’écriture de l’historique échoue, l’erreur remonte — la transaction est annulée', async () => {
      // Le service ne rattrape rien volontairement : c'est `$transaction` de
      // Prisma qui annule. Avaler l'erreur ici produirait exactement l'état que
      // ce chantier supprime — un statut sans historique.
      const boom = new Error('deadlock detected');
      tx.orderHistory.create.mockRejectedValue(boom);

      await expect(
        service.transition(tx as never, {
          ...base,
          from: 'EN_PREPARATION',
          to: 'PRET',
        }),
      ).rejects.toThrow(boom);
    });

    it('n’expose aucune variante hors transaction', () => {
      // Le `tx` est un paramètre obligatoire des trois méthodes publiques.
      // C'est ce qui rend l'atomicité non contournable : il n'existe aucune
      // signature qui permette d'écrire un statut sans son historique.
      for (const method of ['transition', 'tryTransition', 'recordCreation']) {
        expect(
          (service as unknown as Record<string, (...a: unknown[]) => unknown>)[
            method
          ].length,
        ).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('création (S0)', () => {
    it('écrit `fromStatus = null`, sans revendiquer de statut', async () => {
      await service.recordCreation(tx as never, {
        orderId: 'o1',
        to: 'EN_ATTENTE',
        actor: 'CLIENT',
        actorUserId: 'u-client',
        source: 'APP',
      });

      // Aucun `updateMany` : la ligne vient d'être insérée dans la même
      // transaction, personne d'autre ne la connaît. Un verrou optimiste y
      // serait une écriture inutile et suggérerait une concurrence inexistante.
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(tx.orderHistory.create.mock.calls[0][0].data).toMatchObject({
        fromStatus: null,
        toStatus: 'EN_ATTENTE',
        actionId: 'CLIENT',
      });
    });
  });

  describe('vocabulaire', () => {
    it('traduit les rôles Prisma, et refuse l’inconnu plutôt que d’inventer', () => {
      expect(actorFromRole('RESTAURATEUR')).toBe('RESTAURATEUR');
      expect(actorFromRole('LIVREUR')).toBe('LIVREUR');
      expect(actorFromRole('MODERATEUR')).toBeNull();
    });

    it('déduit la provenance du rôle : l’ADMIN agit depuis un back-office', () => {
      expect(sourceFromRole('ADMIN')).toBe('ADMIN_APP');
      expect(sourceFromRole('RESTAURATEUR')).toBe('APP');
      expect(sourceFromRole('CLIENT')).toBe('APP');
    });

    it('les valeurs admises sont closes', () => {
      // Ces deux listes sont le contrat des colonnes `actionId` et `source`,
      // qui sont des TEXT en base. Rien d'autre ne les borne.
      expect([...ORDER_TRANSITION_ACTORS]).toEqual([
        'CLIENT',
        'RESTAURATEUR',
        'LIVREUR',
        'ADMIN',
        'SYSTEM',
      ]);
      expect([...ORDER_TRANSITION_SOURCES]).toEqual([
        'APP',
        'ADMIN_APP',
        'BACKEND',
        'WEBHOOK',
        'POLLING',
        'CRON',
      ]);
    });
  });

  describe('échéance d’acceptation (F3-01)', () => {
    const paidAt = new Date('2026-09-24T12:00:00Z');
    const toPaid = {
      ...base,
      from: 'EN_ATTENTE' as const,
      to: 'PAYER' as const,
      actor: 'SYSTEM' as const,
      actorUserId: null,
      source: 'WEBHOOK' as const,
      data: { paidAt },
    };

    function withAcceptance(required: boolean) {
      tx.platformSettings.findUnique.mockResolvedValue({
        orderAcceptanceRequired: required,
        vendorAcceptanceTimeoutMinutes: 8,
        preorderAcceptanceHours: 2,
      });
      Object.assign(tx.order, {
        findUnique: jest.fn().mockResolvedValue({
          isPreorder: false,
          scheduledFor: null,
          restaurant: { preorderLeadHours: null },
        }),
      });
    }

    it('au passage à PAYER, pose l’échéance DANS le même updateMany que le statut', async () => {
      withAcceptance(true);

      await service.tryTransition(tx as never, toPaid);

      expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'EN_ATTENTE' },
        data: {
          status: 'PAYER',
          paidAt,
          acceptDeadlineAt: new Date('2026-09-24T12:08:00Z'),
        },
      });
    });

    it('interrupteur éteint : aucune échéance — rien n’expirera au moment de l’allumer', async () => {
      withAcceptance(false);

      await service.tryTransition(tx as never, toPaid);

      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'EN_ATTENTE' },
        data: { status: 'PAYER', paidAt },
      });
    });

    it('une transition autre que PAYER ne lit ni réglages ni commande', async () => {
      withAcceptance(true);

      await service.transition(tx as never, {
        ...base,
        from: 'EN_PREPARATION',
        to: 'PRET',
      });

      expect(tx.platformSettings.findUnique).not.toHaveBeenCalled();
    });
  });
});
