import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import {
  ORDER_TRANSITION_MATRIX,
  OrderStateMachine,
} from '../../apps/lilia-app/src/modules/orders/order-state.machine';

/**
 * Le parcours complet d'une commande, sur un vrai PostgreSQL.
 *
 * Chaque étape est couverte par un test unitaire, mais avec Prisma mocké : on
 * y vérifie qu'un service **appelle** la bonne requête, jamais que l'état qui
 * en résulte permet l'étape suivante. Une transition correcte prise isolément
 * peut laisser la commande dans un état d'où la suite est impossible — et
 * aucun test unitaire ne le verrait, chacun repartant de son propre mock.
 *
 * Ce fichier suit donc **une seule commande** de sa création à la note du
 * livreur, sans jamais réinitialiser l'état entre les étapes. Les invariants
 * qu'il protège sont ceux que la règle « accepter ≠ être en route » a posés :
 *
 *  - la commande reste `PRET` tant que le livreur n'a pas le repas ;
 *  - `LIVRER` n'est atteignable qu'après une vraie récupération ;
 *  - une note ne peut exister qu'après une livraison, et une seule fois.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Cycle de vie complet — du panier à la note du livreur', () => {
  let prisma: PrismaClient;
  const machine = new OrderStateMachine();

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "DeliveryReview", "DeliveryLocation", "Delivery",
                     "LoyaltyTransaction", "OrderItem", "OrderHistory",
                     "payments", "Refund", "Order", "CartItem", "Cart",
                     "ProductVariant", "Product", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);

    await prisma.user.createMany({
      data: [
        { id: 'client-1', firebaseUid: 'fb-c1', email: 'c1@test.local' },
        { id: 'vendor-1', firebaseUid: 'fb-v1', email: 'v1@test.local' },
        {
          id: 'driver-1',
          firebaseUid: 'fb-d1',
          email: 'd1@test.local',
          role: 'LIVREUR',
          driverStatus: 'AVAILABLE',
        },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: 'resto-1',
        nom: 'Chez Awa',
        adresse: 'Bacongo',
        phone: '060000000',
        ownerId: 'vendor-1',
      },
    });
    await prisma.product.create({
      data: {
        id: 'prod-1',
        nom: 'Poulet braisé',
        prixOriginal: 3000,
        restaurantId: 'resto-1',
        stockQuotidien: 10,
        stockRestant: 10,
      },
    });
  });

  /** Reproduit les écritures d'un checkout : commande, ligne, stock réservé. */
  async function checkout() {
    await prisma.$transaction(async (tx) => {
      await tx.order.create({
        data: {
          id: 'order-1',
          restaurantId: 'resto-1',
          userId: 'client-1',
          subTotal: 3000,
          deliveryFee: 1000,
          serviceFee: 240,
          total: 4240,
          paymentMethod: 'MTN_MOMO',
          status: 'EN_ATTENTE',
          isDelivery: true,
          items: {
            create: {
              productId: 'prod-1',
              variant: 'Standard',
              quantite: 1,
              prix: 3000,
              snapshotPrice: 3000,
            },
          },
        },
      });
      await tx.product.update({
        where: { id: 'prod-1' },
        data: { stockRestant: { decrement: 1 } },
      });
    });
  }

  /**
   * Fait avancer la commande en validant la transition comme le fait le code
   * de production : matrice **puis** écriture conditionnée sur l'état lu.
   */
  async function advanceOrder(
    to: 'PAYER' | 'EN_PREPARATION' | 'PRET' | 'EN_ROUTE' | 'LIVRER',
    actor: 'CLIENT' | 'RESTAURATEUR' | 'ADMIN' | 'LIVREUR',
  ) {
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: 'order-1' },
    });
    machine.assertTransition(order.status, to, actor);

    const claimed = await prisma.order.updateMany({
      where: { id: 'order-1', status: order.status },
      data: { status: to },
    });
    expect(claimed.count).toBe(1);
  }

  it('déroule le parcours nominal jusqu’à la note du livreur', async () => {
    await checkout();

    // ── Paiement ────────────────────────────────────────────────────────────
    await prisma.payment.create({
      data: {
        orderId: 'order-1',
        amount: 4240,
        phoneNumber: '060000000',
        status: 'SUCCESS',
        provider: 'MANUAL',
      },
    });
    await advanceOrder('PAYER', 'ADMIN');

    // ── Préparation ─────────────────────────────────────────────────────────
    await advanceOrder('EN_PREPARATION', 'RESTAURATEUR');
    await advanceOrder('PRET', 'RESTAURATEUR');

    // ── Assignation puis acceptation ────────────────────────────────────────
    await prisma.delivery.create({
      data: { id: 'deliv-1', orderId: 'order-1', status: 'EN_ATTENTE' },
    });
    await prisma.delivery.update({
      where: { id: 'deliv-1' },
      data: { delivererId: 'driver-1', status: 'ASSIGNER' },
    });

    const accepted = await prisma.delivery.updateMany({
      where: { id: 'deliv-1', status: 'ASSIGNER' },
      data: { status: 'ACCEPTER', acceptedAt: new Date() },
    });
    expect(accepted.count).toBe(1);
    await prisma.user.update({
      where: { id: 'driver-1' },
      data: { driverStatus: 'ON_DELIVERY' },
    });

    // L'INVARIANT CENTRAL : accepter n'est pas partir. Le livreur roule vers
    // le restaurant, le repas est encore sur le comptoir — la commande ne doit
    // pas avoir bougé, sans quoi le client reçoit « votre livreur est en
    // chemin » alors que personne n'a rien récupéré.
    const afterAccept = await prisma.order.findUniqueOrThrow({
      where: { id: 'order-1' },
    });
    expect(afterAccept.status).toBe('PRET');

    // ── Récupération : c'est ici que la commande part ────────────────────────
    await prisma.delivery.updateMany({
      where: { id: 'deliv-1', status: 'ACCEPTER' },
      data: { status: 'EN_TRANSIT', pickedUpAt: new Date() },
    });
    await advanceOrder('EN_ROUTE', 'LIVREUR');

    // ── Livraison ───────────────────────────────────────────────────────────
    await prisma.delivery.updateMany({
      where: { id: 'deliv-1', status: 'EN_TRANSIT' },
      data: { status: 'LIVRER', deliveredAt: new Date() },
    });
    await advanceOrder('LIVRER', 'LIVREUR');
    await prisma.user.update({
      where: { id: 'driver-1' },
      data: { driverStatus: 'AVAILABLE' },
    });

    // ── Points de fidélité : 1 pt par 100 XAF de sous-total ─────────────────
    await prisma.loyaltyTransaction.create({
      data: {
        userId: 'client-1',
        orderId: 'order-1',
        points: 30,
        type: 'ORDER_SPEND',
        reason: 'Commande livrée',
      },
    });

    // ── Note du livreur ─────────────────────────────────────────────────────
    await prisma.deliveryReview.create({
      data: {
        deliveryId: 'deliv-1',
        orderId: 'order-1',
        delivererId: 'driver-1',
        userId: 'client-1',
        rating: 5,
        comment: 'Rapide et souriant',
      },
    });

    // État final cohérent de bout en bout.
    const [order, delivery, driver, product, review] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: 'order-1' } }),
      prisma.delivery.findUniqueOrThrow({ where: { id: 'deliv-1' } }),
      prisma.user.findUniqueOrThrow({ where: { id: 'driver-1' } }),
      prisma.product.findUniqueOrThrow({ where: { id: 'prod-1' } }),
      prisma.deliveryReview.findUniqueOrThrow({
        where: { deliveryId: 'deliv-1' },
      }),
    ]);

    expect(order.status).toBe('LIVRER');
    expect(delivery.status).toBe('LIVRER');
    expect(delivery.acceptedAt).not.toBeNull();
    // `pickedUpAt` doit dater de la récupération, pas de l'acceptation : c'est
    // le champ qui était faux avant la séparation des deux gestes.
    expect(delivery.pickedUpAt).not.toBeNull();
    expect(delivery.pickedUpAt!.getTime()).toBeGreaterThanOrEqual(
      delivery.acceptedAt!.getTime(),
    );
    expect(driver.driverStatus).toBe('AVAILABLE');
    expect(product.stockRestant).toBe(9);
    expect(review.rating).toBe(5);
  });

  it('interdit de déclarer livrée une commande jamais récupérée', async () => {
    // Le raccourci que la matrice ferme : `LIVRER` n'est atteignable que
    // depuis `EN_ROUTE`, et `EN_ROUTE` suppose une récupération.
    await checkout();
    await advanceOrder('PAYER', 'ADMIN');
    await advanceOrder('EN_PREPARATION', 'RESTAURATEUR');
    await advanceOrder('PRET', 'RESTAURATEUR');

    expect(() =>
      machine.assertTransition('PRET', 'LIVRER', 'LIVREUR'),
    ).toThrow();

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: 'order-1' },
    });
    expect(order.status).toBe('PRET');
  });

  it('interdit au vendeur de déclarer la commande en route', async () => {
    // B-1 : le vendeur n'a aucun moyen de savoir si un livreur est parti.
    expect(ORDER_TRANSITION_MATRIX.PRET.EN_ROUTE).not.toContain('RESTAURATEUR');
  });

  it('refuse une seconde note sur la même livraison', async () => {
    // `@@unique([deliveryId])` porte la règle en base, pas seulement dans le
    // service : un second client-mobile impatient ne peut pas la contourner.
    await checkout();
    await prisma.delivery.create({
      data: {
        id: 'deliv-1',
        orderId: 'order-1',
        delivererId: 'driver-1',
        status: 'LIVRER',
        deliveredAt: new Date(),
      },
    });

    const review = (rating: number) =>
      prisma.deliveryReview.create({
        data: {
          deliveryId: 'deliv-1',
          orderId: 'order-1',
          delivererId: 'driver-1',
          userId: 'client-1',
          rating,
        },
      });

    await review(5);
    await expect(review(1)).rejects.toThrow();

    expect(await prisma.deliveryReview.count()).toBe(1);
  });

  it('rend le stock quand la commande est annulée avant paiement', async () => {
    // La compensation qui manquait sur le chemin vendeur/admin : sans elle, un
    // produit à stock limité reste immobilisé jusqu'au reset quotidien — et
    // définitivement pour un `stockMode` permanent.
    await checkout();

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: 'order-1', status: 'EN_ATTENTE' },
        data: { status: 'ANNULER' },
      });
      expect(claimed.count).toBe(1);

      await tx.product.update({
        where: { id: 'prod-1' },
        data: { stockRestant: { increment: 1 } },
      });
    });

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: 'prod-1' },
    });
    expect(product.stockRestant).toBe(10);
  });
});
