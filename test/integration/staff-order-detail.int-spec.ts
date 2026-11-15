import { PrismaPg } from '@prisma/adapter-pg';
import { OrderStatus, PrismaClient } from '@prisma/client';

import { PaginationService } from '../../apps/lilia-app/src/common/pagination/pagination.service';
import { OrderQueryService } from '../../apps/lilia-app/src/modules/orders/order-query.service';

/**
 * **Lot 2 (ADM-02) — la fiche commande du back-office se relit par identifiant.**
 *
 * La fiche de l'app vendeurs ne se rafraîchissait que si la commande figurait
 * dans les vingt plus récentes : hors de cette page, elle restait figée sur
 * l'instantané de navigation. `GET /orders/restaurant/:id` rend la commande
 * telle qu'un élément de liste, avec la MÊME portée que la liste, sur un vrai
 * PostgreSQL :
 *
 * - le vendeur ne lit que sa boutique (une commande d'un concurrent ⇒ 404, sans
 *   en révéler l'existence) ; l'ADMIN lit tout ;
 * - jamais le code de retrait : le vendeur qui le recevrait validerait seul sa
 *   remise, donc son propre versement.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Lot 2 — lecture d’une commande par le personnel (PostgreSQL réel)',
  () => {
    let prisma: PrismaClient;
    let query: OrderQueryService;

    beforeAll(async () => {
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: DATABASE_URL }),
      });
      await prisma.$connect();
      query = new OrderQueryService(prisma as never, new PaginationService());
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PickupHandover", "OrderItem", "OrderHistory", "Order",
                     "Restaurant", "User", "PlatformSettings"
      RESTART IDENTITY CASCADE
    `);
      await prisma.user.createMany({
        data: [
          {
            id: 'own-a',
            firebaseUid: 'fb-own-a',
            email: 'a@test.local',
            role: 'RESTAURATEUR',
          },
          {
            id: 'own-b',
            firebaseUid: 'fb-own-b',
            email: 'b@test.local',
            role: 'RESTAURATEUR',
          },
          {
            id: 'adm',
            firebaseUid: 'fb-adm',
            email: 'adm@test.local',
            role: 'ADMIN',
          },
          {
            id: 'cli',
            firebaseUid: 'fb-cli',
            email: 'cli@test.local',
            nom: 'Awa',
            phone: '060000099',
          },
        ],
      });
      await prisma.restaurant.createMany({
        data: [
          {
            id: 'resto-a',
            nom: 'Chez A',
            adresse: 'Poto-Poto',
            phone: '060000001',
            ownerId: 'own-a',
          },
          {
            id: 'resto-b',
            nom: 'Chez B',
            adresse: 'Bacongo',
            phone: '060000002',
            ownerId: 'own-b',
          },
        ],
      });
      await prisma.order.create({
        data: {
          id: 'ord-a',
          restaurantId: 'resto-a',
          userId: 'cli',
          subTotal: 4000,
          deliveryFee: 0,
          deliveryFeeGross: 0,
          total: 4000,
          paymentMethod: 'MTN_MOMO',
          isDelivery: false,
          status: OrderStatus.PRET,
        },
      });
      await prisma.pickupHandover.create({
        data: { orderId: 'ord-a', code: '4821' },
      });
    });

    it('le vendeur lit sa commande et ses gestes, le client désigné par le numéro (lot C)', async () => {
      const order = await query.findRestaurantOrderById('fb-own-a', 'ord-a');

      expect(order).toMatchObject({
        id: 'ord-a',
        status: 'PRET',
        userId: null,
        contactPhone: null,
        user: { id: null, nom: 'Client #ORD-A', phone: null, imageUrl: null },
        restaurant: { nom: 'Chez A' },
      });
      expect(JSON.stringify(order)).not.toContain('060000099');
      expect(JSON.stringify(order)).not.toContain('"cli"');
      expect(order.allowedActions).toContain('HAND_OVER');
    });

    it('l’ADMIN voit toujours le client (lot C)', async () => {
      const order = await query.findRestaurantOrderById('fb-adm', 'ord-a');

      expect(order).toMatchObject({
        userId: 'cli',
        user: { id: 'cli', nom: 'Awa', phone: '060000099' },
      });
    });

    it('livraison : le vendeur voit le quartier, ni l’adresse ni le téléphone saisi (lot C)', async () => {
      // `nom` est unique et la table n'est pas vidée entre deux exécutions.
      const quartier = await prisma.quartier.upsert({
        where: { nom: 'Poto-Poto (test lot C)' },
        create: { nom: 'Poto-Poto (test lot C)' },
        update: {},
      });
      await prisma.order.create({
        data: {
          id: 'ord-liv',
          restaurantId: 'resto-a',
          userId: 'cli',
          subTotal: 4000,
          deliveryFee: 1000,
          deliveryFeeGross: 1000,
          total: 5000,
          paymentMethod: 'MTN_MOMO',
          isDelivery: true,
          status: OrderStatus.EN_PREPARATION,
          deliveryAddress: '12 rue des Manguiers',
          deliveryLandmark: 'Portail bleu',
          deliveryLatitude: -4.2634,
          deliveryLongitude: 15.2429,
          deliveryQuartierId: quartier.id,
          contactPhone: '066123456',
        },
      });

      const order = await query.findRestaurantOrderById('fb-own-a', 'ord-liv');
      expect(order).toMatchObject({
        deliveryAddress: 'Poto-Poto (test lot C)',
        deliveryLandmark: null,
        deliveryLatitude: null,
        deliveryLongitude: null,
        contactPhone: null,
      });
      const json = JSON.stringify(order);
      for (const secret of ['Manguiers', 'Portail', '066123456', '060000099']) {
        expect(json).not.toContain(secret);
      }

      // L'ADMIN garde l'adresse complète.
      const asAdmin = await query.findRestaurantOrderById('fb-adm', 'ord-liv');
      expect(asAdmin).toMatchObject({
        deliveryAddress: '12 rue des Manguiers',
        contactPhone: '066123456',
      });
    });

    it('recherche : le vendeur ne retrouve pas une commande par le téléphone du client (lot C)', async () => {
      const asVendor = await query.findRestaurantOrders(
        'fb-own-a',
        1,
        20,
        undefined,
        '060000099',
      );
      const asAdmin = await query.findRestaurantOrders(
        'fb-adm',
        1,
        20,
        undefined,
        '060000099',
      );
      const byNumber = await query.findRestaurantOrders(
        'fb-own-a',
        1,
        20,
        undefined,
        '#ORD-A',
      );

      expect(asVendor.data).toHaveLength(0);
      expect(asAdmin.data.map((o) => o.id)).toEqual(['ord-a']);
      expect(byNumber.data.map((o) => o.id)).toEqual(['ord-a']);
    });

    it('jamais le code de retrait, ni pour le vendeur ni pour l’ADMIN', async () => {
      const asVendor = await query.findRestaurantOrderById('fb-own-a', 'ord-a');
      const asAdmin = await query.findRestaurantOrderById('fb-adm', 'ord-a');

      expect(JSON.stringify(asVendor)).not.toContain('4821');
      expect(JSON.stringify(asAdmin)).not.toContain('4821');
      expect(asVendor).not.toHaveProperty('pickupCode');
    });

    it('un autre vendeur : 404, sans révéler que la commande existe', async () => {
      await expect(
        query.findRestaurantOrderById('fb-own-b', 'ord-a'),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('l’ADMIN lit la commande de n’importe quel vendeur', async () => {
      const order = await query.findRestaurantOrderById('fb-adm', 'ord-a');

      expect(order).toMatchObject({
        id: 'ord-a',
        restaurant: { nom: 'Chez A' },
      });
    });

    it('commande inconnue : 404', async () => {
      await expect(
        query.findRestaurantOrderById('fb-adm', 'inconnue'),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('même forme qu’un élément de la liste du back-office', async () => {
      const one = await query.findRestaurantOrderById('fb-own-a', 'ord-a');
      const list = await query.findRestaurantOrders('fb-own-a', 1, 20);

      expect(Object.keys(one).sort()).toEqual(Object.keys(list.data[0]).sort());
    });
  },
);
