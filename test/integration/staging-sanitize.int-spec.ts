/* eslint-disable @typescript-eslint/no-require-imports */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';

/**
 * `scripts/db/staging-sanitize.js` sur un vrai PostgreSQL.
 *
 * Ce que le script promet, et qu'un mock ne peut pas prouver : ses requêtes
 * visent les bons noms physiques (`payments`, `restaurant_payouts`), passent
 * les contraintes, épargnent les comptes à garder, et une simulation ne laisse
 * aucune trace.
 */
const { run } = require('../../scripts/db/staging-sanitize') as {
  run: (
    client: Client,
    opts: { keepEmails: string[]; commit: boolean },
  ) => Promise<Array<[string, number]>>;
};

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('staging-sanitize (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let pg: Client;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    pg = new Client({ connectionString: DATABASE_URL });
    await pg.connect();
  });

  afterAll(async () => {
    await pg.end();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PaymentEvent", "restaurant_payouts", "DeliveryLocation",
        "Delivery", "OrderItem", "OrderHistory", "payments", "Refund", "Order",
        "Adresses", "FcmToken", "DeviceInstallation", "OutboxEvent",
        "IncidentMessage", "Incident", "AdminAuditLog",
        "Restaurant", "PlatformSettings", "User"
      RESTART IDENTITY CASCADE
    `);
    await prisma.platformSettings.create({
      data: { id: 'singleton', vendorPayoutAutoEnabled: true },
    });
    await prisma.user.createMany({
      data: [
        {
          id: 'admin',
          firebaseUid: 'fb-admin',
          email: 'admin@lilia.test',
          nom: 'Admin Réel',
          phone: '242069999999',
          role: 'ADMIN',
        },
        {
          id: 'moi',
          firebaseUid: 'fb-moi',
          email: 'Moi@Lilia.test',
          nom: 'Testeur',
          phone: '242068888888',
        },
        {
          id: 'client',
          firebaseUid: 'fb-client',
          email: 'vrai.client@gmail.test',
          nom: 'Vrai Client',
          phone: '242061234567',
          imageUrl: 'https://img.test/c.jpg',
        },
        {
          id: 'owner',
          firebaseUid: 'fb-owner',
          email: 'owner@resto.test',
          role: 'RESTAURATEUR',
        },
      ],
    });
    await prisma.fcmToken.createMany({
      data: [
        { token: 'tok-client', userId: 'client' },
        { token: 'tok-moi', userId: 'moi' },
      ],
    });
    await prisma.adresses.create({
      data: {
        userId: 'client',
        rue: '12 rue Mbochi',
        ville: 'Brazzaville',
        country: 'CG',
        latitude: -4.27,
        longitude: 15.28,
        landmark: 'Derrière la pharmacie',
      },
    });
    await prisma.restaurant.create({
      data: {
        id: 'resto',
        nom: 'Chez Awa',
        adresse: 'Bacongo',
        phone: '061111111',
        email: 'awa@resto.test',
        ownerId: 'owner',
        payoutPhoneNumber: '242061111111',
        payoutProvider: 'MTN_MOMO',
      },
    });
    await prisma.order.createMany({
      data: [
        {
          id: 'o-client',
          restaurantId: 'resto',
          userId: 'client',
          subTotal: 5000,
          deliveryFee: 1000,
          serviceFee: 750,
          total: 6750,
          paymentMethod: 'MTN_MOMO',
          deliveryAddress: '12 rue Mbochi',
          deliveryLatitude: -4.27,
          deliveryLongitude: 15.28,
          contactPhone: '061234567',
          notes: 'Sonner deux fois',
        },
        {
          id: 'o-moi',
          restaurantId: 'resto',
          userId: 'moi',
          subTotal: 5000,
          deliveryFee: 0,
          serviceFee: 750,
          total: 5750,
          paymentMethod: 'MTN_MOMO',
          contactPhone: '068888888',
        },
      ],
    });
    await prisma.payment.createMany({
      data: [
        {
          orderId: 'o-client',
          amount: 6750,
          currency: 'XAF',
          phoneNumber: '242061234567',
          method: 'MTN_MOMO',
          status: 'SUCCESS',
          provider: 'PAWAPAY',
        },
        {
          orderId: 'o-moi',
          amount: 5750,
          currency: 'XAF',
          phoneNumber: '242068888888',
          method: 'MTN_MOMO',
          status: 'SUCCESS',
          provider: 'PAWAPAY',
        },
      ],
    });
    await prisma.outboxEvent.createMany({
      data: [
        { type: 'order.created', aggregateId: 'o-client', payload: {} },
        {
          type: 'order.created',
          aggregateId: 'o-moi',
          payload: {},
          status: 'SENT',
        },
      ],
    });
    // Textes libres et JSON où de vraies personnes ont écrit des coordonnées.
    await prisma.adminAuditLog.create({
      data: {
        actorId: 'admin',
        action: 'PAYOUT_REQUESTED',
        targetType: 'Restaurant',
        targetId: 'resto',
        reason: 'Appel au 061111111',
        metadata: { before: '242061111111', after: '242062222222' },
      },
    });
    await prisma.incident.create({
      data: {
        id: 'inc',
        type: 'ORDER_DELAYED',
        title: 'Retard',
        description: 'Le client au 061234567 attend rue Mbochi',
        resolution: 'Rappelé au 061234567',
        metadata: { phone: '242061234567' },
      },
    });
    await prisma.incidentMessage.create({
      data: {
        incidentId: 'inc',
        authorId: 'client',
        authorRole: 'CLIENT',
        body: 'Mon numéro : 061234567',
        attachments: ['https://res.cloudinary.com/x/preuve.jpg'],
      },
    });
    await prisma.refund.create({
      data: {
        orderId: 'o-client',
        amount: 6750,
        reason: 'Client joint au 061234567',
        notes: 'Virer sur le 242061234567',
      },
    });
  });

  it('neutralise les effets et anonymise, en épargnant ADMIN et comptes gardés', async () => {
    await run(pg, { keepEmails: ['moi@lilia.test'], commit: true });

    // Effets sortants : plus aucun jeton, plus aucun événement à rejouer,
    // versement automatique coupé.
    expect(await prisma.fcmToken.count()).toBe(0);
    expect(
      await prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
    ).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { status: 'SENT' } })).toBe(
      1,
    );
    expect(
      (
        await prisma.platformSettings.findUniqueOrThrow({
          where: { id: 'singleton' },
        })
      ).vendorPayoutAutoEnabled,
    ).toBe(false);

    // Client ordinaire : anonymisé, mais `firebaseUid` intact (connexion).
    const client = await prisma.user.findUniqueOrThrow({
      where: { id: 'client' },
    });
    expect(client.email).toBe('user-client@staging.invalid');
    expect(client.phone).toBeNull();
    expect(client.nom).not.toContain('Vrai');
    expect(client.imageUrl).toBeNull();
    expect(client.firebaseUid).toBe('fb-client');

    const adresse = await prisma.adresses.findFirstOrThrow({
      where: { userId: 'client' },
    });
    expect(adresse.rue).not.toContain('Mbochi');
    expect(adresse.latitude).toBeNull();
    expect(adresse.landmark).toBeNull();

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: 'o-client' },
    });
    expect(order.deliveryAddress).not.toContain('Mbochi');
    expect(order.deliveryLatitude).toBeNull();
    expect(order.contactPhone).toBe('060000000');
    expect(order.notes).toBeNull();
    // L'argent n'est pas touché.
    expect(order.total).toBe(6750);

    const pay = await prisma.payment.findFirstOrThrow({
      where: { orderId: 'o-client' },
    });
    expect(pay.phoneNumber).toBe('242060000000');
    expect(pay.amount).toBe(6750);

    const resto = await prisma.restaurant.findUniqueOrThrow({
      where: { id: 'resto' },
    });
    expect(resto.payoutPhoneNumber).toBe('242060000000');
    expect(resto.phone).toBe('060000000');
    expect(resto.email).toBe('vendor-resto@staging.invalid');
    expect(resto.nom).toBe('Chez Awa');

    // Textes libres et JSON : aucun numéro ne survit.
    const audit = await prisma.adminAuditLog.findFirstOrThrow();
    expect(audit.metadata).toBeNull();
    expect(audit.reason).not.toContain('061111111');
    expect(audit.action).toBe('PAYOUT_REQUESTED');
    const incident = await prisma.incident.findUniqueOrThrow({
      where: { id: 'inc' },
    });
    expect(incident.description).not.toContain('061234567');
    expect(incident.resolution).not.toContain('061234567');
    expect(incident.metadata).toBeNull();
    const message = await prisma.incidentMessage.findFirstOrThrow();
    expect(message.body).not.toContain('061234567');
    expect(message.attachments).toEqual([]);
    const refund = await prisma.refund.findFirstOrThrow();
    expect(refund.reason).not.toContain('061234567');
    expect(refund.notes).toBeNull();
    expect(refund.amount).toBe(6750);

    // ADMIN et compte gardé : intacts, données liées comprises.
    const admin = await prisma.user.findUniqueOrThrow({
      where: { id: 'admin' },
    });
    expect(admin.email).toBe('admin@lilia.test');
    expect(admin.phone).toBe('242069999999');
    const moi = await prisma.user.findUniqueOrThrow({ where: { id: 'moi' } });
    expect(moi.email).toBe('Moi@Lilia.test');
    expect(moi.phone).toBe('242068888888');
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: 'o-moi' } }))
        .contactPhone,
    ).toBe('068888888');
    expect(
      (await prisma.payment.findFirstOrThrow({ where: { orderId: 'o-moi' } }))
        .phoneNumber,
    ).toBe('242068888888');
  });

  it('une simulation compte sans rien écrire', async () => {
    const counts = await run(pg, { keepEmails: [], commit: false });

    expect(new Map(counts).get('FcmToken supprimés')).toBe(2);
    expect(await prisma.fcmToken.count()).toBe(2);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: 'client' } })).email,
    ).toBe('vrai.client@gmail.test');
  });

  it('est rejouable', async () => {
    await run(pg, { keepEmails: [], commit: true });
    await expect(
      run(pg, { keepEmails: [], commit: true }),
    ).resolves.toBeDefined();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: 'client' } })).email,
    ).toBe('user-client@staging.invalid');
  });
});
