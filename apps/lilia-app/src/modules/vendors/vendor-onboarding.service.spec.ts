import { ConflictException } from '@nestjs/common';
import { AdminAuditAction, OnboardingStatus, VendorType } from '@prisma/client';
import { VendorOnboardingService } from './vendor-onboarding.service';
import { VENDOR_INVITATION_EVENT } from './events/vendor-events';

describe('VendorOnboardingService', () => {
  let prisma: any;
  let firebase: any;
  let readiness: any;
  let idempotency: any;
  let outbox: any;
  let audit: any;
  let photos: any;
  let events: any;
  let service: VendorOnboardingService;

  const dto = {
    vendorType: VendorType.RESTAURANT,
    ownerEmail: 'Chef@Resto.CG',
    ownerNom: 'Chef Lilia',
    ownerPhone: '060000001',
    nom: 'Chez Lilia',
    adresse: 'Bacongo',
    phone: '060000002',
  };

  /** Transaction qui exécute réellement le callback avec un client mocké. */
  const runTx = (tx: any) => (cb: any) => cb(tx);

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      restaurant: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    firebase = {
      createUser: jest.fn().mockResolvedValue('fb-uid-1'),
      getAuth: jest.fn(() => ({
        deleteUser: jest.fn().mockResolvedValue(undefined),
      })),
    };
    readiness = { getReport: jest.fn().mockResolvedValue(null) };
    // Par défaut, l'idempotence laisse simplement passer l'opération.
    idempotency = {
      runOnce: jest.fn((_s: string, _k: unknown, op: any) => op()),
    };
    outbox = { enqueueInTransaction: jest.fn().mockResolvedValue('outbox-1') };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    photos = { cleanupCloudinary: jest.fn().mockResolvedValue(undefined) };
    events = { emit: jest.fn() };

    service = new VendorOnboardingService(
      prisma,
      firebase,
      readiness,
      idempotency,
      outbox,
      audit,
      photos,
      events,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  // ─── Création ──────────────────────────────────────────────────────────────

  describe('createVendor', () => {
    const wireHappyPath = () => {
      const tx = {
        user: { create: jest.fn().mockResolvedValue({ id: 'u1' }) },
        restaurant: {
          create: jest.fn().mockResolvedValue({
            id: 'r1',
            nom: 'Chez Lilia',
            vendorType: VendorType.RESTAURANT,
          }),
        },
      };
      prisma.$transaction.mockImplementation(runTx(tx));
      return tx;
    };

    it('crée le compte Firebase avec un mot de passe que personne ne choisit', async () => {
      wireHappyPath();
      await service.createVendor(dto as never, 'admin-1');

      const [args] = firebase.createUser.mock.calls[0];
      expect(args.email).toBe('chef@resto.cg'); // normalisé en minuscules
      // Le secret est aléatoire et long : il n'est ni transmis ni devinable.
      expect(args.password).toEqual(expect.any(String));
      expect(args.password.length).toBeGreaterThanOrEqual(32);
      expect(args.password).not.toContain(dto.ownerNom);
    });

    it('crée le vendeur en DRAFT et fermé', async () => {
      const tx = wireHappyPath();
      await service.createVendor(dto as never, 'admin-1');

      const data = tx.restaurant.create.mock.calls[0][0].data;
      expect(data.onboardingStatus).toBe(OnboardingStatus.DRAFT);
      expect(data.isOpen).toBe(false);
    });

    it('donne le rôle RESTAURATEUR au propriétaire', async () => {
      const tx = wireHappyPath();
      await service.createVendor(dto as never, 'admin-1');
      expect(tx.user.create.mock.calls[0][0].data.role).toBe('RESTAURATEUR');
    });

    it('pose les sept jours de la semaine, tous fermés', async () => {
      const tx = wireHappyPath();
      await service.createVendor(dto as never, 'admin-1');

      const hours =
        tx.restaurant.create.mock.calls[0][0].data.operatingHours.create;
      expect(hours).toHaveLength(7);
      expect(hours.every((h: { isClosed: boolean }) => h.isClosed)).toBe(true);
    });

    it("écrit l'obligation d'inviter DANS la transaction", async () => {
      const tx = wireHappyPath();
      await service.createVendor(dto as never, 'admin-1');

      // Le client transactionnel est passé explicitement : si la transaction
      // échoue, l'obligation disparaît avec elle.
      expect(outbox.enqueueInTransaction).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          type: VENDOR_INVITATION_EVENT,
          aggregateId: 'r1',
        }),
      );
    });

    it('auto-approuve un RESTAURANT mais pas une boulangerie', async () => {
      const tx = wireHappyPath();
      await service.createVendor(dto as never, 'admin-1');
      expect(tx.restaurant.create.mock.calls[0][0].data.adminApproved).toBe(
        true,
      );

      tx.restaurant.create.mockClear();
      await service.createVendor(
        { ...dto, vendorType: VendorType.BAKERY } as never,
        'admin-1',
      );
      expect(tx.restaurant.create.mock.calls[0][0].data.adminApproved).toBe(
        false,
      );
    });

    it('trace la création dans le journal d’audit', async () => {
      wireHappyPath();
      await service.createVendor(dto as never, 'admin-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'admin-1',
          action: AdminAuditAction.VENDOR_CREATED,
          targetId: 'r1',
        }),
      );
    });

    it('refuse un e-mail déjà rattaché à une boutique', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u9',
        role: 'RESTAURATEUR',
        restaurant: { id: 'r9' },
      });
      await expect(
        service.createVendor(dto as never, 'admin-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(firebase.createUser).not.toHaveBeenCalled();
    });

    it('oriente vers le changement de rôle si le compte existe déjà comme client', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u9',
        role: 'CLIENT',
        restaurant: null,
      });
      await expect(
        service.createVendor(dto as never, 'admin-1'),
      ).rejects.toThrow(/RESTAURATEUR/);
    });

    it('supprime le compte Firebase si la transaction échoue', async () => {
      const deleteUser = jest.fn().mockResolvedValue(undefined);
      firebase.getAuth.mockReturnValue({ deleteUser });
      prisma.$transaction.mockRejectedValue(new Error('DB down'));

      await expect(
        service.createVendor(dto as never, 'admin-1'),
      ).rejects.toThrow('DB down');
      expect(deleteUser).toHaveBeenCalledWith('fb-uid-1');
    });

    it('laisse une trace exploitable si même le rollback Firebase échoue', async () => {
      firebase.getAuth.mockReturnValue({
        deleteUser: jest.fn().mockRejectedValue(new Error('Firebase down')),
      });
      prisma.$transaction.mockRejectedValue(new Error('DB down'));
      const errorSpy = jest.spyOn(service['logger'], 'error');

      // L'erreur d'origine remonte : l'échec du nettoyage ne doit pas la masquer.
      await expect(
        service.createVendor(dto as never, 'admin-1'),
      ).rejects.toThrow('DB down');
      // Sans cette trace, l'adresse resterait réservée chez Firebase et toute
      // nouvelle tentative échouerait sans explication.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('orphelin'),
      );
    });

    it('traduit un e-mail déjà pris chez Firebase en conflit explicite', async () => {
      firebase.createUser.mockRejectedValue({
        code: 'auth/email-already-exists',
      });
      await expect(
        service.createVendor(dto as never, 'admin-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('passe par la garde d’idempotence', async () => {
      wireHappyPath();
      await service.createVendor(dto as never, 'admin-1', 'clé-123');
      expect(idempotency.runOnce).toHaveBeenCalledWith(
        'vendor-onboarding',
        'clé-123',
        expect.any(Function),
      );
    });
  });

  // ─── Activation ────────────────────────────────────────────────────────────

  describe('activate', () => {
    const readyReport = {
      restaurantId: 'r1',
      onboardingStatus: OnboardingStatus.DRAFT,
      isReady: true,
      progress: 100,
      checks: [],
      blockingIssues: [],
    };

    it('refuse une boutique incomplète, en nommant ce qui manque', async () => {
      readiness.getReport.mockResolvedValue({
        ...readyReport,
        isReady: false,
        blockingIssues: ['Aucun produit vendable', 'Logo manquant'],
        checks: [
          {
            key: 'catalog',
            label: 'Catalogue',
            status: 'MISSING',
            blocking: true,
          },
        ],
      });

      await expect(service.activate('r1', 'admin-1', {})).rejects.toMatchObject(
        {
          response: expect.objectContaining({
            blockingIssues: ['Aucun produit vendable', 'Logo manquant'],
          }),
        },
      );
      expect(prisma.restaurant.updateMany).not.toHaveBeenCalled();
    });

    it('demande confirmation si seuls des éléments recommandés manquent', async () => {
      readiness.getReport.mockResolvedValue({
        ...readyReport,
        checks: [
          {
            key: 'cover',
            label: 'Couverture',
            status: 'MISSING',
            blocking: false,
          },
        ],
      });
      await expect(
        service.activate('r1', 'admin-1', {}),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('active malgré les recommandations si on le demande explicitement', async () => {
      readiness.getReport.mockResolvedValue({
        ...readyReport,
        checks: [
          {
            key: 'cover',
            label: 'Couverture',
            status: 'MISSING',
            blocking: false,
          },
        ],
      });
      prisma.restaurant.findUniqueOrThrow.mockResolvedValue({
        id: 'r1',
        nom: 'Chez Lilia',
        adminApproved: true,
        vendorType: 'RESTAURANT',
      });

      await service.activate('r1', 'admin-1', { skipRecommendations: true });
      expect(prisma.restaurant.updateMany).toHaveBeenCalled();
    });

    it('active une boutique prête et émet l’événement', async () => {
      readiness.getReport.mockResolvedValue(readyReport);
      prisma.restaurant.findUniqueOrThrow.mockResolvedValue({
        id: 'r1',
        nom: 'Chez Lilia',
        adminApproved: true,
        vendorType: 'RESTAURANT',
      });

      const res = await service.activate('r1', 'admin-1', {});

      const data = prisma.restaurant.updateMany.mock.calls[0][0].data;
      expect(data.onboardingStatus).toBe(OnboardingStatus.ACTIVATED);
      expect(data.activatedById).toBe('admin-1');
      // L'ouverture revient au cron : activer à 23 h ne doit pas ouvrir une
      // boutique qui ferme à 20 h.
      expect(data).not.toHaveProperty('isOpen');
      expect(events.emit).toHaveBeenCalledWith(
        'vendor.activated',
        expect.anything(),
      );
      expect(res.message).toContain('visible');
    });

    it('rejette la seconde activation concurrente', async () => {
      readiness.getReport.mockResolvedValue(readyReport);
      // `updateMany` conditionné : le second appel ne touche aucune ligne.
      prisma.restaurant.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.activate('r1', 'admin-1', {}),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('annonce une visibilité conditionnelle si le vendeur n’est pas approuvé', async () => {
      readiness.getReport.mockResolvedValue(readyReport);
      prisma.restaurant.findUniqueOrThrow.mockResolvedValue({
        id: 'r1',
        nom: 'Boulangerie B',
        adminApproved: false,
        vendorType: 'BAKERY',
      });
      const res = await service.activate('r1', 'admin-1', {});
      expect(res.message).toContain('validation');
    });
  });

  // ─── Statut dérivé ─────────────────────────────────────────────────────────

  describe('getOnboardingState', () => {
    it('fait passer un vendeur complet de DRAFT à READY', async () => {
      readiness.getReport.mockResolvedValue({
        restaurantId: 'r1',
        onboardingStatus: OnboardingStatus.DRAFT,
        isReady: true,
        progress: 100,
        checks: [],
        blockingIssues: [],
      });
      prisma.restaurant.findUnique.mockResolvedValue({ id: 'r1', nom: 'X' });

      const res = await service.getOnboardingState('r1');
      expect(res.data.onboardingStatus).toBe(OnboardingStatus.READY);
      expect(events.emit).toHaveBeenCalledWith(
        'vendor.ready',
        expect.anything(),
      );
    });

    it('ne rétrograde jamais un vendeur déjà activé', async () => {
      // Un vendeur en activité qui supprime son dernier produit ne doit pas
      // disparaître du catalogue sans décision humaine.
      readiness.getReport.mockResolvedValue({
        restaurantId: 'r1',
        onboardingStatus: OnboardingStatus.ACTIVATED,
        isReady: false,
        progress: 80,
        checks: [],
        blockingIssues: ['Aucun produit vendable'],
      });

      const res = await service.getOnboardingState('r1');
      expect(res.data.onboardingStatus).toBe(OnboardingStatus.ACTIVATED);
      expect(prisma.restaurant.updateMany).not.toHaveBeenCalled();
    });

    it("n'émet pas « prêt » deux fois pour le même vendeur", async () => {
      readiness.getReport.mockResolvedValue({
        restaurantId: 'r1',
        onboardingStatus: OnboardingStatus.READY,
        isReady: true,
        progress: 100,
        checks: [],
        blockingIssues: [],
      });

      await service.getOnboardingState('r1');
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  // ─── Livraison ─────────────────────────────────────────────────────────────

  describe('updateDelivery', () => {
    beforeEach(() => {
      prisma.restaurant.findUnique.mockResolvedValue({
        id: 'r1',
        supportsDelivery: true,
        supportsPickup: true,
        estimatedDeliveryTimeMin: 15,
        estimatedDeliveryTimeMax: 30,
      });
      prisma.restaurant.findUniqueOrThrow.mockResolvedValue({ id: 'r1' });
    });

    it('refuse de désactiver à la fois la livraison et le retrait', async () => {
      await expect(
        service.updateDelivery('r1', {
          supportsDelivery: false,
          supportsPickup: false,
        }),
      ).rejects.toThrow(/au moins la livraison ou le retrait/);
    });

    it('refuse un délai minimum supérieur au maximum', async () => {
      await expect(
        service.updateDelivery('r1', { estimatedDeliveryTimeMin: 90 }),
      ).rejects.toThrow(/ne peut pas dépasser/);
    });

    it('compare au delta : un seul champ envoyé est confronté à l’existant', async () => {
      // 10 min de min contre 30 en base : cohérent, doit passer.
      await service.updateDelivery('r1', { estimatedDeliveryTimeMin: 10 });
      expect(prisma.restaurant.update).toHaveBeenCalled();
    });
  });

  // ─── Identité ──────────────────────────────────────────────────────────────

  describe('updateIdentity', () => {
    it("supprime l'ancien logo de Cloudinary lors d'un remplacement", async () => {
      prisma.restaurant.findUnique.mockResolvedValue({
        id: 'r1',
        imageUrl: 'https://cdn/ancien.png',
        imagePublicId: 'lilia-food/restaurants/ancien',
      });
      prisma.restaurant.update.mockResolvedValue({ id: 'r1' });
      prisma.restaurant.findUniqueOrThrow.mockResolvedValue({ id: 'r1' });

      await service.updateIdentity('r1', {
        imageUrl: 'https://cdn/nouveau.png',
        imagePublicId: 'lilia-food/restaurants/nouveau',
      });

      expect(photos.cleanupCloudinary).toHaveBeenCalledWith(
        'lilia-food/restaurants/ancien',
      );
    });

    it('ne supprime rien si le loge reste le même', async () => {
      prisma.restaurant.findUnique.mockResolvedValue({
        id: 'r1',
        imageUrl: 'https://cdn/logo.png',
        imagePublicId: 'lilia-food/restaurants/logo',
      });
      prisma.restaurant.update.mockResolvedValue({ id: 'r1' });
      prisma.restaurant.findUniqueOrThrow.mockResolvedValue({ id: 'r1' });

      await service.updateIdentity('r1', { nom: 'Nouveau nom' });
      expect(photos.cleanupCloudinary).not.toHaveBeenCalled();
    });
  });
});
