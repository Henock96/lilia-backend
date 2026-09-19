import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeliveryStatus, PrismaClient } from '@prisma/client';

import { DeliveryAssignmentService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment.service';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { PlatformSettingsService } from '../../apps/lilia-app/src/modules/platform-settings/platform-settings.service';

/**
 * **L'économie d'une course, contre un vrai PostgreSQL.**
 *
 * Les tests unitaires du gel mockent Prisma : ils prouvent que le service
 * *demande* la bonne écriture, jamais que la base l'*accepte*. Or ce chantier
 * introduit deux types énumérés et six colonnes sur une table déjà en
 * production. Une valeur d'enum mal orthographiée, une colonne absente d'une
 * migration, un `include` qui ne remonte pas le profil : rien de tout cela ne
 * se voit sur un mock, et tout se voit ici.
 *
 * Le dépôt a déjà payé cette leçon deux fois — un worker qui compilait et
 * mourait au bootstrap, une méthode dont aucun test ne construisait la requête.
 * « Un binaire qui compile n'est pas un binaire qui démarre. »
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Économie de la course — gel, effacement, réassignation', () => {
  let prisma: PrismaClient;
  let assignment: DeliveryAssignmentService;

  const OWNER = 'de-owner';
  const CLIENT = 'de-client';
  const DRIVER_A = 'de-driver-a';
  const DRIVER_B = 'de-driver-b';
  const VENDOR = 'de-vendor';
  const ORDER = 'de-order';
  const DELIVERY = 'de-delivery';

  /** Remet la course en `ASSIGNER` sur un livreur donné, sans économie. */
  const resetDelivery = async (delivererId: string) => {
    await prisma.delivery.update({
      where: { id: DELIVERY },
      data: {
        delivererId,
        status: DeliveryStatus.ASSIGNER,
        driverBaseXaf: null,
        driverEmploymentType: null,
        driverCompensationModel: null,
        driverSharePercent: null,
        driverPayXaf: null,
        driverEconomicsFrozenAt: null,
      },
    });
    await prisma.user.update({
      where: { id: delivererId },
      data: { driverStatus: 'AVAILABLE' },
    });
  };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();

    assignment = new DeliveryAssignmentService(
      prisma as never,
      new EventEmitter2(),
      new OrderStateMachine(),
      new OrderTransitionService(),
      new PlatformSettingsService(prisma as never),
    );

    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PaymentEvent", "restaurant_payouts", "OutboxEvent",
                     "Incident", "DeliveryReview", "DeliveryLocation",
                     "Delivery", "LoyaltyTransaction", "OrderItem",
                     "OrderHistory", "payments", "Refund", "Order",
                     "CartItem", "Cart", "ProductVariant", "Product",
                     "DriverProfile", "Restaurant", "User", "PlatformSettings"
      RESTART IDENTITY CASCADE
    `);

    await prisma.user.createMany({
      data: [
        { id: CLIENT, firebaseUid: 'fb-de-c', email: 'de-c@test.local' },
        {
          id: OWNER,
          firebaseUid: 'fb-de-o',
          email: 'de-o@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: DRIVER_A,
          firebaseUid: 'fb-de-a',
          email: 'de-a@test.local',
          role: 'LIVREUR',
          driverStatus: 'AVAILABLE',
        },
        {
          id: DRIVER_B,
          firebaseUid: 'fb-de-b',
          email: 'de-b@test.local',
          role: 'LIVREUR',
          driverStatus: 'AVAILABLE',
        },
      ],
    });

    // A est un livreur Lilia au taux plateforme ; B un indépendant.
    await prisma.driverProfile.createMany({
      data: [
        {
          userId: DRIVER_A,
          vehicleType: 'MOTO',
          isActive: true,
          employmentType: 'LILIA',
          compensationModel: 'PER_DELIVERY',
        },
        {
          userId: DRIVER_B,
          vehicleType: 'MOTO',
          isActive: true,
          employmentType: 'INDEPENDENT',
          compensationModel: 'PER_DELIVERY',
        },
      ],
    });

    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez Maman Test',
        adresse: 'Poto-Poto',
        phone: '060000009',
        ownerId: OWNER,
      },
    });

    // ⚠️ `deliveryFee = 0` (livraison offerte) mais `deliveryFeeGross = 1000` :
    // c'est exactement le cas que la décision D-4 protège.
    await prisma.order.create({
      data: {
        id: ORDER,
        restaurantId: VENDOR,
        userId: CLIENT,
        subTotal: 5000,
        deliveryFee: 0,
        deliveryFeeGross: 1000,
        serviceFee: 750,
        total: 5750,
        paymentMethod: 'MTN_MOMO',
        status: 'PRET',
      },
    });

    await prisma.delivery.create({
      data: {
        id: DELIVERY,
        orderId: ORDER,
        delivererId: DRIVER_A,
        status: DeliveryStatus.ASSIGNER,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. les taux plateforme existent, avec les valeurs arbitrées', async () => {
    const settings = await prisma.platformSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });

    expect(settings.driverSharePercentLilia).toBe(35);
    expect(settings.driverSharePercentIndependent).toBe(65);
  });

  it('2. un livreur Lilia accepte : 35 % du tarif BRUT sont figés en base', async () => {
    await assignment.acceptDelivery(DELIVERY, 'fb-de-a');

    const d = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });

    expect(d.status).toBe(DeliveryStatus.ACCEPTER);
    // L'assiette est le BRUT (1 000), pas le net après remise (0).
    expect(d.driverBaseXaf).toBe(1000);
    expect(d.driverEmploymentType).toBe('LILIA');
    expect(d.driverCompensationModel).toBe('PER_DELIVERY');
    expect(d.driverSharePercent).toBe(35);
    expect(d.driverPayXaf).toBe(350);
    expect(d.driverEconomicsFrozenAt).not.toBeNull();
  });

  it('3. l’invariant tient sur la ligne réellement écrite', async () => {
    const d = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });

    // La part de Lilia n'est pas stockée : elle se déduit, et elle boucle.
    expect(d.driverBaseXaf! - d.driverPayXaf!).toBe(650);
    expect(d.driverPayXaf! + (d.driverBaseXaf! - d.driverPayXaf!)).toBe(
      d.driverBaseXaf,
    );
  });

  it('4. réassignation : l’économie de l’ancien livreur est effacée en base', async () => {
    await assignment.assignDeliverer(DELIVERY, DRIVER_B, 'fb-de-o');

    const d = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });

    expect(d.delivererId).toBe(DRIVER_B);
    expect(d.status).toBe(DeliveryStatus.ASSIGNER);
    // Sans cet effacement, la course porterait 350 XAF dus à un livreur qui ne
    // la fera pas — et le calcul de contribution les compterait.
    expect(d.driverPayXaf).toBeNull();
    expect(d.driverEconomicsFrozenAt).toBeNull();
    expect(d.driverEmploymentType).toBeNull();
  });

  it('5. le repreneur est INDÉPENDANT : son acceptation fige 65 %, pas 35 %', async () => {
    await prisma.user.update({
      where: { id: DRIVER_B },
      data: { driverStatus: 'AVAILABLE' },
    });

    await assignment.acceptDelivery(DELIVERY, 'fb-de-b');

    const d = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });

    // C'est tout l'enjeu de la décision « seul le livreur qui TERMINE est
    // payé » : un snapshot écrit une seule fois aurait payé B au tarif de A.
    expect(d.driverEmploymentType).toBe('INDEPENDENT');
    expect(d.driverSharePercent).toBe(65);
    expect(d.driverPayXaf).toBe(650);
  });

  it('6. un taux propre au livreur prime sur le taux plateforme', async () => {
    await prisma.driverProfile.update({
      where: { userId: DRIVER_A },
      data: { driverSharePercent: 42 },
    });
    await resetDelivery(DRIVER_A);

    await assignment.acceptDelivery(DELIVERY, 'fb-de-a');

    const d = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });
    expect(d.driverSharePercent).toBe(42);
    expect(d.driverPayXaf).toBe(420);
  });

  it('7. un taux propre à 0 % reste 0 % — le piège `||` contre `??`', async () => {
    await prisma.driverProfile.update({
      where: { userId: DRIVER_A },
      data: { driverSharePercent: 0 },
    });
    await resetDelivery(DRIVER_A);

    await assignment.acceptDelivery(DELIVERY, 'fb-de-a');

    const d = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });
    // Un `||` aurait retenu 35 % et payé ce livreur contre son contrat.
    expect(d.driverSharePercent).toBe(0);
    expect(d.driverPayXaf).toBe(0);
    // Le snapshot EXISTE quand même : « il touche 0 » est une information,
    // pas une absence d'information.
    expect(d.driverEconomicsFrozenAt).not.toBeNull();
  });

  it('8. modèle SALARY : part nulle, et le zéro reste lisible', async () => {
    await prisma.driverProfile.update({
      where: { userId: DRIVER_A },
      data: { compensationModel: 'SALARY', driverSharePercent: null },
    });
    await resetDelivery(DRIVER_A);

    await assignment.acceptDelivery(DELIVERY, 'fb-de-a');

    const d = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });
    expect(d.driverCompensationModel).toBe('SALARY');
    expect(d.driverPayXaf).toBe(0);
    // `null` et non 35 : aucun taux ne s'applique au salaire.
    expect(d.driverSharePercent).toBeNull();
    // C'est ce champ qui distingue ce 0-là du 0 du test 7.
    expect(d.driverEconomicsFrozenAt).not.toBeNull();
  });

  it('9. livreur sans profil : aucune économie écrite, acceptation réussie', async () => {
    await prisma.driverProfile.delete({ where: { userId: DRIVER_A } });
    await resetDelivery(DRIVER_A);

    await assignment.acceptDelivery(DELIVERY, 'fb-de-a');

    const d = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });
    expect(d.status).toBe(DeliveryStatus.ACCEPTER);
    // Le coût reste UNKNOWN. Écrire 0 en ferait « il n'a rien coûté ».
    expect(d.driverPayXaf).toBeNull();
    expect(d.driverEconomicsFrozenAt).toBeNull();
  });
});
