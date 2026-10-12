import { BadRequestException } from '@nestjs/common';
import {
  AdminVendorSubscriptionsController,
  VendorSubscriptionController,
} from './subscriptions.controller';

/**
 * Premium (Lot 2) — ce que les contrôleurs ajoutent au service : l'en-tête
 * d'idempotence exigé et un verdict vendeur résolu par le compte connecté.
 * L'audit est écrit par le service, dans la transaction du geste — il est
 * prouvé sur PostgreSQL réel (`vendor-subscriptions.int-spec.ts`).
 */
describe('Abonnements — contrôleurs', () => {
  const period = {
    id: 'sub-1',
    restaurantId: 'v1',
    plan: 'PREMIUM',
    status: 'ACTIVE',
    startsAt: new Date('2026-10-11T09:00:00Z'),
    endsAt: new Date('2026-11-11T09:00:00Z'),
    priceXaf: 15000,
    paymentMethod: 'MOBILE_MONEY',
    paymentReference: 'MP123',
  };
  const admin = { id: 'admin-1' } as never;
  const dto = {
    paymentMethod: 'MOBILE_MONEY' as const,
    paymentReference: 'MP123',
  };

  const service = {
    grant: jest.fn(),
    revoke: jest.fn(),
    listForVendor: jest.fn(),
    verdictForOwner: jest.fn(),
  };
  const controller = new AdminVendorSubscriptionsController(service as never);

  beforeEach(() => jest.clearAllMocks());

  describe('POST /admin/vendors/:id/subscriptions', () => {
    it('sans Idempotency-Key : 400, rien n’est enregistré', async () => {
      await expect(
        controller.grant('v1', dto, admin, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.grant('v1', dto, admin, '   '),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(service.grant).not.toHaveBeenCalled();
    });

    it('clé démesurée : 400', async () => {
      await expect(
        controller.grant('v1', dto, admin, 'x'.repeat(201)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('enregistrement : transmet la clé, l’admin et la saisie au service', async () => {
      service.grant.mockResolvedValue({
        subscription: period,
        replayed: false,
      });
      const res = await controller.grant('v1', dto, admin, ' key-1 ');

      expect(service.grant).toHaveBeenCalledWith(
        expect.objectContaining({
          restaurantId: 'v1',
          adminId: 'admin-1',
          requestKey: 'key-1',
          paymentMethod: 'MOBILE_MONEY',
          paymentReference: 'MP123',
        }),
      );
      expect(res.data).toBe(period);
    });

    it('rejeu de la même clé : même période, message distinct', async () => {
      service.grant.mockResolvedValue({ subscription: period, replayed: true });
      const res = await controller.grant('v1', dto, admin, 'key-1');
      expect(res.data).toBe(period);
      expect(res.message).toBe('Cette période était déjà enregistrée.');
    });
  });

  it('révocation : motif transmis au service', async () => {
    service.revoke.mockResolvedValue({ ...period, status: 'REVOKED' });
    await controller.revoke(
      'v1',
      'sub-1',
      { reason: 'Paiement annulé' },
      admin,
    );
    expect(service.revoke).toHaveBeenCalledWith(
      'v1',
      'sub-1',
      'admin-1',
      'Paiement annulé',
    );
  });

  it('GET /vendors/me/subscription : verdict résolu par le compte, pas par un identifiant', async () => {
    const verdict = { plan: null, active: false, entitlements: [] };
    service.verdictForOwner.mockResolvedValue(verdict);
    const mine = new VendorSubscriptionController(service as never);

    const res = await mine.mine({ id: 'owner-1' } as never);

    expect(service.verdictForOwner).toHaveBeenCalledWith('owner-1');
    expect(res.data).toBe(verdict);
  });
});
