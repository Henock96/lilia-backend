import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { DashboardController } from '../dashboard/dashboard.controller';
import { projectDeliveryForDriver } from '../deliveries/delivery-driver-projection';
import { RestaurantsController } from '../restaurants/restaurants.controller';
import { buildOrderSearchWhere } from './order-search';
import {
  VENDOR_HIDDEN_ORDER_FIELDS,
  projectOrderForVendor,
  projectOrdersForVendor,
  vendorCustomerLabel,
} from './vendor-order-projection';

/**
 * Lot C (15/11/2026, D2) — seul le RESTAURATEUR perd l'identité du client.
 * Le livreur garde ce qu'il lui faut pour livrer ; l'admin voit tout.
 */
const order = {
  id: 'cmdabcd1234xyz',
  status: 'EN_PREPARATION',
  isDelivery: true,
  total: 7500,
  notes: 'Sans piment',
  userId: 'client-1',
  contactPhone: '066123456',
  deliveryAddress: '12 rue des Manguiers',
  deliveryLandmark: 'Portail bleu',
  deliveryLatitude: -4.2634,
  deliveryLongitude: 15.2429,
  deliveryQuartierId: 'q-poto',
  user: {
    id: 'client-1',
    nom: 'Awa Mabiala',
    phone: '066123456',
    email: 'awa@exemple.cg',
    imageUrl: 'https://img/awa.jpg',
  },
};

const IDENTITY = [
  'client-1',
  'Awa Mabiala',
  '066123456',
  'awa@exemple.cg',
  'https://img/awa.jpg',
  '12 rue des Manguiers',
  'Portail bleu',
  '-4.2634',
  '15.2429',
];

describe('Vendeur : commande sans client (lot C, D2)', () => {
  it('numéro identique à celui de la carte de commande (8 premiers caractères)', () => {
    expect(vendorCustomerLabel('cmdabcd1234xyz')).toBe('Client #CMDABCD1');
  });

  it('ni nom, ni téléphone, ni e-mail, ni photo, ni adresse ; le quartier reste', () => {
    const shown = projectOrderForVendor(order, 'Poto-Poto');
    const json = JSON.stringify(shown);
    for (const value of IDENTITY) expect(json).not.toContain(value);

    expect(shown.user).toEqual({
      id: null,
      nom: 'Client #CMDABCD1',
      phone: null,
      email: null,
      imageUrl: null,
    });
    expect(shown.deliveryAddress).toBe('Poto-Poto');
    for (const key of VENDOR_HIDDEN_ORDER_FIELDS) {
      if (key !== 'deliveryAddress') expect(shown[key]).toBeNull();
    }
    // Ce qui sert à préparer reste là.
    expect(shown).toMatchObject({ total: 7500, notes: 'Sans piment' });
  });

  it('page de commandes : un seul aller-retour pour les quartiers', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'q-poto', nom: 'Poto-Poto' }]);
    const prisma = { quartier: { findMany } } as never;

    const shown = await projectOrdersForVendor(prisma, [
      order,
      { ...order, id: 'autre12345' },
      {
        ...order,
        id: 'retrait123',
        isDelivery: false,
        deliveryQuartierId: null,
      },
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(shown.map((o) => o.deliveryAddress)).toEqual([
      'Poto-Poto',
      'Poto-Poto',
      null,
    ]);
  });

  it('recherche vendeur : par numéro ou boutique, jamais par nom ni téléphone', () => {
    const where = buildOrderSearchWhere('066123456', { customerFields: false });
    const json = JSON.stringify(where);
    expect(json).not.toContain('"user"');
    expect(json).not.toContain('contactPhone');
    expect(where).toEqual({
      OR: [
        { id: { contains: '066123456', mode: 'insensitive' } },
        { restaurant: { nom: { contains: '066123456', mode: 'insensitive' } } },
      ],
    });
  });

  it('recherche admin inchangée : nom et téléphone du client', () => {
    const json = JSON.stringify(buildOrderSearchWhere('066123456'));
    expect(json).toContain('"user"');
    expect(json).toContain('contactPhone');
  });

  it('le livreur garde le nom, le téléphone et l’adresse du client à livrer', () => {
    const course = projectDeliveryForDriver({
      id: 'd1',
      status: 'EN_TRANSIT',
      order,
    }) as { order: Record<string, unknown> };

    expect(course.order).toMatchObject({
      contactPhone: '066123456',
      deliveryAddress: '12 rue des Manguiers',
      deliveryLandmark: 'Portail bleu',
      deliveryLatitude: -4.2634,
      deliveryLongitude: 15.2429,
      user: { nom: 'Awa Mabiala', phone: '066123456' },
    });
  });

  it.each([
    [RestaurantsController.prototype.findClients],
    [RestaurantsController.prototype.getClientOrders],
    [DashboardController.prototype.getClientDetail],
  ])(
    'liste et fiche clients : ADMIN seulement (D2.c, 403 au vendeur)',
    (handler) => {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['ADMIN']);
    },
  );
});
