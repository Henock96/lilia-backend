import { collectRoleRoutes } from '../../../test/admin-routes';
import {
  forbiddenDriverKeysIn,
  fullDeliveryRow,
} from '../../../test/driver-exposure';
import { projectDeliveryForDriver } from './delivery-driver-projection';

/**
 * D-PAY (DEL-002) — garde CI : AUCUNE réponse destinée à un livreur ne porte
 * de donnée de rémunération ni l'économie de la commande.
 *
 * Toute route ouverte au rôle LIVREUR doit être classée ici. Une route
 * nouvelle, non classée, fait échouer ce test : il faut décider, en la
 * créant, ce qu'elle rend au livreur (même motif que la garde ADMIN F3-08).
 *
 * - PROJECTED : rend une course → passe par `projectDeliveryForDriver`
 *   (testé sur la méthode de service elle-même, voir les specs de service).
 * - SELECT : `select` explicite sans aucun montant (relu le 08/10/2026).
 * - NO_DELIVERY_DATA : ne rend ni course, ni commande, ni montant.
 */
const LIVREUR_ROUTE_EXPOSURE: Record<string, string> = {
  'CloudinaryController.uploadImage': 'NO_DELIVERY_DATA',
  'DeliveriesController.acceptDelivery': 'PROJECTED',
  'DeliveriesController.confirmPickup': 'PROJECTED',
  'DeliveriesController.declineDelivery': 'NO_DELIVERY_DATA',
  'DeliveriesController.findByOrderId': 'SELECT',
  'DeliveriesController.findMyDeliveries': 'PROJECTED',
  'DeliveriesController.findOne': 'PROJECTED',
  'DeliveriesController.getMyMissions': 'PROJECTED',
  // Rend la ligne `User` du livreur lui-même : aucune colonne de
  // rémunération (la paie vit sur `Delivery` / `DriverSettlement`).
  'DeliveriesController.setStatus': 'NO_DELIVERY_DATA',
  'DeliveriesController.updateLocation': 'NO_DELIVERY_DATA',
  'DeliveriesController.updateStatus': 'PROJECTED',
  'DeliveryFailureController.call': 'NO_DELIVERY_DATA',
  'DeliveryFailureController.declare': 'NO_DELIVERY_DATA',
  'DeliveryFailureController.start': 'NO_DELIVERY_DATA',
  'DeliveryReviewsController.findByDelivery': 'SELECT',
  'DeliveryReviewsController.findMine': 'SELECT',
  'DeliveryReviewsController.getDelivererStats': 'NO_DELIVERY_DATA',
  'DriversController.findMe': 'SELECT',
  'DriversController.updateMe': 'SELECT',
  'TrackingController.batchPositions': 'NO_DELIVERY_DATA',
  'TrackingController.updatePosition': 'NO_DELIVERY_DATA',
};

describe('Routes LIVREUR — exposition (D-PAY, DEL-002)', () => {
  const routes = collectRoleRoutes('LIVREUR').map((r) => r.key);

  it('aucune route LIVREUR non classée, aucune entrée orpheline', () => {
    expect(routes.filter((k) => !(k in LIVREUR_ROUTE_EXPOSURE))).toEqual([]);
    expect(
      Object.keys(LIVREUR_ROUTE_EXPOSURE).filter((k) => !routes.includes(k)),
    ).toEqual([]);
  });

  it('« Mes gains » n’existe plus côté livreur (Q6)', () => {
    expect(routes.some((k) => k.startsWith('DriverEarningsController'))).toBe(
      false,
    );
  });
});

describe('projectDeliveryForDriver', () => {
  it('une course complète ne laisse passer AUCUNE clé interdite', () => {
    const row = fullDeliveryRow();
    // Le témoin : la ligne brute en porte bien.
    expect(forbiddenDriverKeysIn(row).length).toBeGreaterThan(20);
    expect(forbiddenDriverKeysIn(projectDeliveryForDriver(row))).toEqual([]);
  });

  it('garde ce que la course exige : destination, contact, articles, retrait', () => {
    const out = projectDeliveryForDriver(fullDeliveryRow()) as {
      status: string;
      order: Record<string, unknown> & {
        restaurant: Record<string, unknown>;
        user: Record<string, unknown>;
        items: Array<Record<string, unknown>>;
      };
    };
    expect(out.status).toBe('EN_TRANSIT');
    expect(out.order).toMatchObject({
      deliveryAddress: 'Moungali, rue 12',
      deliveryLatitude: -4.27,
      deliveryPrecision: 'EXACT',
      deliveryLandmark: 'portail bleu',
      contactPhone: '+242060000000',
      user: { nom: 'Client', phone: '+242061111111' },
    });
    expect(out.order.restaurant).toEqual({
      id: 'r1',
      nom: 'Resto',
      adresse: 'Poto-Poto',
      phone: '+242062222222',
      vendorType: 'RESTAURANT',
      latitude: -4.25,
      longitude: 15.26,
    });
    expect(out.order.items).toEqual([
      {
        id: 'i1',
        quantite: 2,
        product: { nom: 'Poulet DG', imageUrl: null, madeToOrder: false },
      },
    ]);
  });

  it('liste blanche : une colonne inconnue (ajoutée demain) est masquée', () => {
    const row = {
      ...fullDeliveryRow(),
      someFutureColumn: 1,
      order: { ...fullDeliveryRow().order, someFutureOrderColumn: 1 },
    };
    const out = projectDeliveryForDriver(row) as {
      order: Record<string, unknown>;
    };
    expect(out).not.toHaveProperty('someFutureColumn');
    expect(out.order).not.toHaveProperty('someFutureOrderColumn');
    expect(out).not.toHaveProperty('delivererId');
    expect(out.order).not.toHaveProperty('userId');
    expect(out.order).not.toHaveProperty('notes');
  });

  it('ligne nue (réponse de mutation) : pas de commande inventée', () => {
    const { order: _order, ...bare } = fullDeliveryRow('ACCEPTER');
    const out = projectDeliveryForDriver(bare);
    expect(out).not.toHaveProperty('order');
    expect(out).toMatchObject({ id: 'd1', status: 'ACCEPTER' });
    expect(forbiddenDriverKeysIn(out)).toEqual([]);
  });
});
