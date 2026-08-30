import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { RestaurantsService } from './restaurants.service';
import { RestaurantAccessService } from './restaurant-access.service';
import { RestaurantQueryService } from './restaurant-query.service';
import { RestaurantHoursService } from './restaurant-hours.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Table d'autorisation des analytics vendeur (fix C1 — audit du 28/08/2026).
 *
 * C'est LE test que l'audit désigne comme le meilleur ratio valeur/effort du
 * projet : 193 endpoints sur 196 faisaient correctement leur contrôle de
 * propriété, les 3 restants suffisaient à exfiltrer la base clients complète de
 * la plateforme depuis un simple compte restaurateur. Le rôle était vérifié,
 * l'**objet** ne l'était pas.
 *
 * Pour chaque endpoint sensible, quatre appelants :
 *   1. le propriétaire       → autorisé
 *   2. un autre propriétaire → 403
 *   3. un rôle non concerné  → 403
 *   4. un ADMIN              → autorisé
 *
 * Ce qui transforme une propriété tenue par la discipline en propriété tenue
 * par la CI.
 */
describe('Restaurants — autorisation des analytics (C1)', () => {
  let service: RestaurantsService;

  const RESTO = {
    id: 'resto-A',
    owner: { firebaseUid: 'uid-owner-A' },
  };

  const prisma = {
    restaurant: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
  };

  const query = {
    countOrders: jest.fn().mockResolvedValue({ data: { count: 42 } }),
    findClients: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    findClientWithOrders: jest.fn().mockResolvedValue({ data: [] }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.restaurant.findUnique.mockResolvedValue(RESTO);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RestaurantsService,
        RestaurantAccessService, // service réel : c'est lui qu'on teste
        { provide: PrismaService, useValue: prisma },
        { provide: RestaurantQueryService, useValue: query },
        { provide: RestaurantHoursService, useValue: {} },
      ],
    }).compile();

    service = module.get<RestaurantsService>(RestaurantsService);
  });

  /** Chaque entrée : nom lisible + appel du service avec le uid donné. */
  const endpoints: [string, (uid: string) => Promise<unknown>][] = [
    [
      'GET /restaurants/:id/orders/count',
      (uid) => service.countOrders(RESTO.id, uid),
    ],
    [
      'GET /restaurants/:id/clients',
      (uid) => service.findClients(1, 10, RESTO.id, uid),
    ],
    [
      'GET /restaurants/:id/clients/:userId/orders',
      (uid) => service.findClientWithOrders(RESTO.id, 'client-1', uid),
    ],
  ];

  describe.each(endpoints)('%s', (_name, call) => {
    it('propriétaire → autorisé', async () => {
      await expect(call('uid-owner-A')).resolves.toBeDefined();
    });

    it('autre RESTAURATEUR → 403 (le cœur de la faille C1)', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: 'RESTAURATEUR' });
      await expect(call('uid-owner-B')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('CLIENT → 403', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: 'CLIENT' });
      await expect(call('uid-client')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('LIVREUR → 403', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: 'LIVREUR' });
      await expect(call('uid-livreur')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('ADMIN → autorisé', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
      await expect(call('uid-admin')).resolves.toBeDefined();
    });

    it('restaurant inexistant → 404', async () => {
      prisma.restaurant.findUnique.mockResolvedValue(null);
      await expect(call('uid-owner-A')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("n'atteint JAMAIS la requête quand l'accès est refusé", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: 'RESTAURATEUR' });
      await expect(call('uid-owner-B')).rejects.toThrow();
      expect(query.countOrders).not.toHaveBeenCalled();
      expect(query.findClients).not.toHaveBeenCalled();
      expect(query.findClientWithOrders).not.toHaveBeenCalled();
    });
  });

  it("ne renvoie plus l'e-mail des clients au vendeur (minimisation)", async () => {
    // Le select réel est vérifié dans restaurant-query ; ici on fige le
    // contrat de la façade : elle délègue sans réintroduire de champ.
    await service.findClients(1, 10, RESTO.id, 'uid-owner-A');
    expect(query.findClients).toHaveBeenCalledWith(1, 10, RESTO.id);
  });
});
