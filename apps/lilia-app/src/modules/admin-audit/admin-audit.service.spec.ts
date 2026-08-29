import { AdminAuditAction } from '@prisma/client';

import { AdminAuditService } from './admin-audit.service';

/**
 * Journal des actions d'administration.
 *
 * Deux exigences s'opposent, et l'arbitrage entre elles est tout le sujet :
 *
 *  - **tracer** — bannir un compte, changer un rôle ou confirmer un paiement
 *    doit laisser une trace durable et interrogeable, pas une ligne de log
 *    perdue à la prochaine rotation ;
 *  - **ne jamais bloquer** — si la table d'audit est en peine, l'action doit
 *    quand même aboutir. Un admin qui n'arrive plus à débannir un client
 *    parce que le journal est indisponible, c'est le journal qui prend
 *    l'exploitation en otage.
 *
 * Le second point est le piège classique : on écrit l'audit dans le même
 * chemin que l'action, et une contrainte oubliée fait tomber les deux. Ces
 * tests le figent.
 *
 * Le module était livré sans aucun test (audit post-correction).
 */
describe('AdminAuditService', () => {
  let prisma: {
    adminAuditLog: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
  };
  let service: AdminAuditService;
  let loggedErrors: string[];

  beforeEach(() => {
    prisma = {
      adminAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new AdminAuditService(prisma as never);

    loggedErrors = [];
    jest
      .spyOn(service['logger'], 'error')
      .mockImplementation((msg: unknown) => {
        loggedErrors.push(String(msg));
      });
  });

  const entry = {
    actorId: 'admin-1',
    action: AdminAuditAction.USER_BANNED,
    targetType: 'User' as const,
    targetId: 'user-42',
    reason: 'Fraude au parrainage',
  };

  describe('record', () => {
    it('écrit une ligne avec acteur, cible et motif', async () => {
      await service.record(entry);

      expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorId: 'admin-1',
          action: AdminAuditAction.USER_BANNED,
          targetType: 'User',
          targetId: 'user-42',
          reason: 'Fraude au parrainage',
        }),
      });
    });

    it('normalise un motif absent en null plutôt qu’undefined', async () => {
      // `undefined` et `null` ne sont pas équivalents pour Prisma :
      // `undefined` signifie « ne touche pas à ce champ ».
      await service.record({ ...entry, reason: undefined });

      expect(prisma.adminAuditLog.create.mock.calls[0][0].data.reason).toBe(
        null,
      );
    });

    it("n'échoue pas quand le journal est indisponible", async () => {
      // Le cœur du contrat : l'action d'administration a déjà eu lieu ou est
      // en train d'avoir lieu. Propager cette erreur la ferait échouer — ou
      // pire, la laisserait à moitié appliquée.
      prisma.adminAuditLog.create.mockRejectedValue(
        new Error('table verrouillée'),
      );

      await expect(service.record(entry)).resolves.toBeUndefined();
    });

    it('laisse une trace exploitable de ce qui n’a pas pu être journalisé', async () => {
      // Puisque l'échec est avalé, le log est la dernière chance de savoir
      // qu'une action sensible n'a pas été tracée. Il doit contenir de quoi la
      // reconstituer : qui, quoi, sur qui.
      prisma.adminAuditLog.create.mockRejectedValue(
        new Error('table verrouillée'),
      );

      await service.record(entry);

      const message = loggedErrors.join(' ');
      expect(message).toContain('admin-1');
      expect(message).toContain('user-42');
      expect(message).toContain(AdminAuditAction.USER_BANNED);
      expect(message).toContain('table verrouillée');
    });
  });

  describe('list', () => {
    it('sert le journal du plus récent au plus ancien', async () => {
      // Inverse de la file de remboursements : ici on consulte ce qui vient
      // de se passer, pas ce qui attend depuis longtemps.
      await service.list({});

      expect(prisma.adminAuditLog.findMany.mock.calls[0][0].orderBy).toEqual({
        createdAt: 'desc',
      });
    });

    it('filtre par action et par cible', async () => {
      // Les deux questions d'une enquête : « qu’a-t-on fait de ce compte ? »
      // et « qui a banni des gens ce mois-ci ? ».
      await service.list({
        action: AdminAuditAction.USER_BANNED,
        targetId: 'user-42',
      });

      expect(prisma.adminAuditLog.findMany.mock.calls[0][0].where).toEqual({
        action: AdminAuditAction.USER_BANNED,
        targetId: 'user-42',
      });
    });

    it('n’applique aucun filtre quand aucun n’est demandé', async () => {
      // Un `where` mal construit (`{ action: undefined }`) ne filtre rien chez
      // Prisma, mais la nuance est fragile : on vérifie qu'il est bien vide.
      await service.list({});

      expect(prisma.adminAuditLog.findMany.mock.calls[0][0].where).toEqual({});
    });

    it('pagine', async () => {
      await service.list({ page: 2, limit: 25 });

      const query = prisma.adminAuditLog.findMany.mock.calls[0][0];
      expect(query.skip).toBe(25);
      expect(query.take).toBe(25);
    });
  });
});
