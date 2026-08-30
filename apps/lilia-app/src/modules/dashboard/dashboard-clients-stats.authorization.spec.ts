import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { DashboardClientsStatsService } from './dashboard-clients-stats.service';
import { DashboardCommonService } from './dashboard-common.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * `GET /dashboard/clients/:clientId` (fix C2 — audit du 28/08/2026).
 *
 * Le module dashboard dérivait bien son périmètre du `firebaseUid` de
 * l'appelant… mais ne l'appliquait qu'à la requête `order`. Le bloc identité
 * partait sans le moindre filtre : tout compte RESTAURATEUR pouvait lire nom,
 * e-mail, téléphone, code de parrainage, solde de points et jusqu'à 5 adresses
 * de DOMICILE de n'importe quel utilisateur de la plateforme.
 */
describe('Dashboard — détail client (C2)', () => {
  let service: DashboardClientsStatsService;

  const prisma = {
    user: { findUnique: jest.fn() },
    order: { findMany: jest.fn(), count: jest.fn() },
  };
  const common = { getRestaurant: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.order.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      nom: 'Awa',
      phone: '060000000',
      adresses: [],
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardClientsStatsService,
        { provide: PrismaService, useValue: prisma },
        { provide: DashboardCommonService, useValue: common },
      ],
    }).compile();

    service = module.get(DashboardClientsStatsService);
  });

  it('vendeur → 403 si le client n’a jamais commandé chez lui', async () => {
    common.getRestaurant.mockResolvedValue({ id: 'resto-A' });
    prisma.order.count.mockResolvedValue(0);

    await expect(
      service.getClientDetail('uid-owner-A', 'client-inconnu'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Le point critique : on ne charge même pas l'identité.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('vendeur → autorisé si le client a commandé chez lui', async () => {
    common.getRestaurant.mockResolvedValue({ id: 'resto-A' });
    prisma.order.count.mockResolvedValue(3);

    const res = await service.getClientDetail('uid-owner-A', 'client-1');
    expect(res.data.client).toBeDefined();
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: { userId: 'client-1', restaurantId: 'resto-A' },
    });
  });

  it('ADMIN (sans restaurant) → périmètre global, assumé', async () => {
    common.getRestaurant.mockResolvedValue(null);

    const res = await service.getClientDetail('uid-admin', 'client-1');
    expect(res.data.client).toBeDefined();
    expect(prisma.order.count).not.toHaveBeenCalled();
  });

  it('n’expose ni e-mail ni code de parrainage au vendeur', async () => {
    common.getRestaurant.mockResolvedValue({ id: 'resto-A' });
    prisma.order.count.mockResolvedValue(1);

    await service.getClientDetail('uid-owner-A', 'client-1');

    const select = prisma.user.findUnique.mock.calls[0][0].select;
    expect(select.email).toBeUndefined();
    expect(select.referralCode).toBeUndefined();
    expect(select.referredByCode).toBeUndefined();
    // Ce dont le vendeur a réellement besoin reste servi.
    expect(select.nom).toBe(true);
    expect(select.phone).toBe(true);
  });

  it('client introuvable → 404', async () => {
    common.getRestaurant.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.getClientDetail('uid-admin', 'inexistant'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
