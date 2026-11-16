import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { OrderValidatorService } from '../../apps/lilia-app/src/modules/orders/order-validator.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { ReservationBookingService } from '../../apps/lilia-app/src/modules/reservations/reservation-booking.service';
import { ReservationLifecycleService } from '../../apps/lilia-app/src/modules/reservations/reservation-lifecycle.service';
import { ReservationSettingsService } from '../../apps/lilia-app/src/modules/reservations/reservation-settings.service';
import { ReservationVendorService } from '../../apps/lilia-app/src/modules/reservations/reservation-vendor.service';
import { VendorSubscriptionService } from '../../apps/lilia-app/src/modules/subscriptions/vendor-subscription.service';

/**
 * Lot 4 (4B-1) — réservations client, PostgreSQL réel.
 *
 * Ce qu'un mock ne peut pas montrer :
 *  · deux clients qui visent la dernière table en même temps : une seule
 *    demande passe (verrou `Restaurant … FOR NO KEY UPDATE`) ;
 *  · la même clé rejouée, y compris en parallèle : une seule réservation ;
 *  · un geste du vendeur et une expiration simultanés : une seule transition ;
 *  · aucune écriture partielle (panier, journal, outbox) quand on refuse ;
 *  · les CHECK de la migration, en base.
 *
 * Heure de Brazzaville = UTC+1. NOW = lundi 19/10/2026 10:00 locale ;
 * DATE = mardi 20/10/2026 (plage 12:00–14:00).
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

// `toSatisfy` (jest-extended) n'est pas dans la dépendance : défini ici, pour
// lire le `code` d'une erreur HTTP et l'afficher en clair quand il diffère.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toSatisfy(predicate: (value: unknown) => boolean): R;
    }
  }
}
expect.extend({
  toSatisfy(received: unknown, predicate: (value: unknown) => boolean) {
    const pass = predicate(received);
    const shown =
      (received as { getResponse?: () => unknown })?.getResponse?.() ??
      String(received);
    return {
      pass,
      message: () => `valeur reçue : ${JSON.stringify(shown)}`,
    };
  },
});

const NOW = new Date('2026-10-19T09:00:00Z');
const DATE = '2026-10-20';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** 12:00 à Brazzaville, le 20/10. */
const NOON = new Date('2026-10-20T11:00:00Z');
const after = (ms: number) => new Date(NOW.getTime() + ms);

const ALL_DAYS = [
  'LUNDI',
  'MARDI',
  'MERCREDI',
  'JEUDI',
  'VENDREDI',
  'SAMEDI',
  'DIMANCHE',
] as const;

describeIfDb('Réservations client (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let booking: ReservationBookingService;
  let vendor: ReservationVendorService;
  let lifecycle: ReservationLifecycleService;
  let config: ReservationSettingsService;
  let platformEnabled = true;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    const settings = {
      getSettings: async () => ({
        reservationsEnabled: platformEnabled,
        premiumMonthlyPriceXaf: 15000,
      }),
    };
    const outbox = new OutboxService(prisma as never);
    booking = new ReservationBookingService(
      prisma as never,
      outbox,
      new VendorSubscriptionService(prisma as never, settings as never),
      settings as never,
      // Seuls `validateAndGetUser` et `validateStock` servent : ni promo ni
      // ouverture n'y sont lues.
      new OrderValidatorService(prisma as never, null as never, null as never),
    );
    vendor = new ReservationVendorService(prisma as never, outbox);
    lifecycle = new ReservationLifecycleService(prisma as never, outbox);
    config = new ReservationSettingsService(
      prisma as never,
      new VendorSubscriptionService(prisma as never, settings as never),
      settings as never,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    platformEnabled = true;
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "ReservationEvent", "ReservationItemOption",
        "ReservationItem", "Reservation", "OutboxEvent", "CartItemOption",
        "CartItem", "Cart", "ProductVariant", "Product", "ReservationWindow",
        "ReservationSpace", "ReservationSettings", "VendorSubscription",
        "VendorClosure", "PublicHoliday", "OperatingHours", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
    for (const n of [1, 2]) {
      await prisma.user.create({
        data: {
          id: `o${n}`,
          firebaseUid: `fb-o${n}`,
          email: `o${n}@t.local`,
          role: 'RESTAURATEUR',
        },
      });
      await prisma.restaurant.create({
        data: {
          id: `v${n}`,
          nom: `Restaurant ${n}`,
          adresse: 'Poto-Poto',
          phone: `06000009${n}`,
          ownerId: `o${n}`,
          vendorType: 'RESTAURANT',
          onboardingStatus: 'ACTIVATED',
          adminApproved: true,
          isActive: true,
        },
      });
      await prisma.operatingHours.createMany({
        data: ALL_DAYS.map((dayOfWeek) => ({
          restaurantId: `v${n}`,
          dayOfWeek,
          openTime: '08:00',
          closeTime: '23:00',
        })),
      });
      await prisma.product.create({
        data: {
          id: `p${n}`,
          nom: `Poulet DG ${n}`,
          prixOriginal: 5000,
          restaurantId: `v${n}`,
          variants: { create: { id: `var${n}`, prix: 5000, label: 'Normal' } },
        },
      });
    }
    await prisma.reservationSettings.create({
      data: { restaurantId: 'v1', enabled: true, updatedById: 'o1' },
    });
    await prisma.reservationWindow.create({
      data: {
        restaurantId: 'v1',
        dayOfWeek: 'MARDI',
        startTime: '12:00',
        endTime: '14:00',
      },
    });
    await table('t1', 'Table 1');
    await premium('v1');
    for (const n of [1, 2, 3]) {
      await prisma.user.create({
        data: {
          id: `c${n}`,
          firebaseUid: `fb-c${n}`,
          email: `c${n}@t.local`,
          phone: `06123456${n}`,
        },
      });
      await cart(`c${n}`, 'p1', 'var1');
    }
  });

  const table = (id: string, label: string, min = 1, max = 4) =>
    prisma.reservationSpace.create({
      data: {
        id,
        restaurantId: 'v1',
        kind: 'TABLE',
        label,
        labelKey: label.toLowerCase(),
        minGuests: min,
        maxGuests: max,
      },
    });

  const seats = (id: string, label: string, seatCount: number) =>
    prisma.reservationSpace.create({
      data: {
        id,
        restaurantId: 'v1',
        kind: 'SEATS',
        label,
        labelKey: label.toLowerCase(),
        seatCount,
        maxSeatsPerBooking: seatCount,
      },
    });

  const premium = (restaurantId: string) =>
    prisma.vendorSubscription.create({
      data: {
        restaurantId,
        plan: 'PREMIUM',
        status: 'ACTIVE',
        startsAt: new Date(NOW.getTime() - DAY),
        endsAt: new Date(NOW.getTime() + 29 * DAY),
        priceXaf: 15000,
        paymentMethod: 'CASH',
        requestKey: `k-${restaurantId}-${Math.random()}`,
        grantedById: 'admin-test',
      },
    });

  const cart = (userId: string, productId: string, variantId: string) =>
    prisma.cart.create({
      data: {
        id: `cart-${userId}`,
        userId,
        items: { create: { productId, variantId, quantite: 2 } },
      },
    });

  const user = (n: number) => ({
    id: `c${n}`,
    firebaseUid: `fb-c${n}`,
    phone: `06123456${n}`,
  });

  const book = (
    n: number,
    key: string,
    over: Partial<{ time: string; partySize: number; date: string }> = {},
    now = NOW,
  ) =>
    booking.create(
      user(n),
      key,
      {
        restaurantId: 'v1',
        date: over.date ?? DATE,
        time: over.time ?? '12:00',
        partySize: over.partySize ?? 2,
      },
      now,
    );

  const codeOf = (e: unknown) =>
    (e as { getResponse?: () => { code?: string } }).getResponse?.()?.code;

  const outboxOf = (type = 'reservation.notice') =>
    prisma.outboxEvent.findMany({
      where: { type },
      orderBy: { createdAt: 'asc' },
    });

  describe('demande', () => {
    it('crée une demande PENDING avec sa table, sa précommande, son journal et son avis au vendeur — panier vidé', async () => {
      const r = await book(1, 'k1');
      expect(r).toMatchObject({
        status: 'PENDING',
        partySize: 2,
        spaceLabel: 'Table 1',
        contactPhone: '061234561',
        allowedActions: ['cancel'],
      });
      expect(new Date(r.arrivalAt).getTime()).toBe(NOON.getTime());
      expect(new Date(r.responseDeadlineAt).getTime()).toBe(
        NOW.getTime() + 30 * MIN,
      );
      expect(r.items).toEqual([
        expect.objectContaining({
          productId: 'p1',
          variantId: 'var1',
          quantite: 2,
          productName: 'Poulet DG 1',
          variantLabel: 'Normal',
        }),
      ]);
      expect(
        await prisma.cartItem.count({ where: { cartId: 'cart-c1' } }),
      ).toBe(0);
      const events = await prisma.reservationEvent.findMany({
        where: { reservationId: r.id },
      });
      expect(events).toEqual([
        expect.objectContaining({
          fromStatus: null,
          toStatus: 'PENDING',
          actorRole: 'CLIENT',
          toSpaceId: 't1',
        }),
      ]);
      const notices = await outboxOf();
      expect(notices).toHaveLength(1);
      expect(notices[0].payload).toMatchObject({
        notice: 'REQUESTED',
        audience: 'VENDOR',
        recipientUserId: 'o1',
      });
    });

    it('même clé rejouée : même réservation, aucun second avis ; autre demande sur la même clé : 409', async () => {
      const first = await book(1, 'k1');
      const again = await book(1, 'k1');
      expect(again.id).toBe(first.id);
      expect(await prisma.reservation.count()).toBe(1);
      expect(await outboxOf()).toHaveLength(1);
      await expect(book(1, 'k1', { time: '13:00' })).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('même clé envoyée deux fois en parallèle : une seule réservation', async () => {
      const results = await Promise.allSettled([book(1, 'kp'), book(1, 'kp')]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok.length).toBeGreaterThanOrEqual(1);
      expect(await prisma.reservation.count()).toBe(1);
      expect(await outboxOf()).toHaveLength(1);
      for (const r of ok) {
        expect((r as PromiseFulfilledResult<{ id: string }>).value.id).toBe(
          (ok[0] as PromiseFulfilledResult<{ id: string }>).value.id,
        );
      }
    });

    it('dernière table, deux clients en même temps : une seule demande passe, l’autre garde son panier', async () => {
      const results = await Promise.allSettled([book(1, 'a'), book(2, 'b')]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const ko = results.filter(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(ko).toHaveLength(1);
      expect(codeOf(ko[0].reason)).toBe('RESERVATION_SLOT_UNAVAILABLE');
      expect(await prisma.reservation.count()).toBe(1);
      expect(await outboxOf()).toHaveLength(1);
      // Le perdant n'a rien perdu : sa transaction est annulée en entier.
      // Trois paniers au départ (c1, c2, c3) : seul celui du gagnant est vidé.
      expect(await prisma.cartItem.count()).toBe(2);
    });

    it('espace de places : deux groupes de 3 sur 4 places en même temps, un seul', async () => {
      await prisma.reservationSpace.update({
        where: { id: 't1' },
        data: { archivedAt: NOW },
      });
      await seats('s1', 'Comptoir', 4);
      const results = await Promise.allSettled([
        book(1, 'a', { partySize: 3 }),
        book(2, 'b', { partySize: 3 }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      // Un groupe de 1 tient encore à côté (3 + 1 = 4).
      await expect(book(3, 'c', { partySize: 1 })).resolves.toMatchObject({
        status: 'PENDING',
        spaceLabel: 'Comptoir',
      });
    });

    it('heure hors du pas ou trop proche : 409, rien d’écrit', async () => {
      await expect(book(1, 'a', { time: '12:15' })).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_SLOT_UNAVAILABLE',
      );
      // 11:00 locale le mardi, 1 h avant midi : sous le délai minimal (2 h).
      await expect(
        book(1, 'b', {}, new Date('2026-10-20T10:00:00Z')),
      ).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_SLOT_UNAVAILABLE',
      );
      expect(await prisma.reservation.count()).toBe(0);
      expect(
        await prisma.cartItem.count({ where: { cartId: 'cart-c1' } }),
      ).toBe(1);
    });

    it('non réservable (interrupteur, Premium, boutique non publiée) : même 404 partout', async () => {
      platformEnabled = false;
      await expect(book(1, 'a')).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_NOT_BOOKABLE',
      );
      await expect(
        booking.availability('v1', { date: DATE }, NOW),
      ).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_NOT_BOOKABLE',
      );
      platformEnabled = true;
      await prisma.vendorSubscription.deleteMany({});
      await expect(book(1, 'b')).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_NOT_BOOKABLE',
      );
      await premium('v1');
      await prisma.restaurant.update({
        where: { id: 'v1' },
        data: { onboardingStatus: 'DRAFT' },
      });
      await expect(book(1, 'c')).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_NOT_BOOKABLE',
      );
      // Restaurant sans configuration : même réponse.
      await expect(booking.availability('v2', {}, NOW)).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_NOT_BOOKABLE',
      );
      expect(await prisma.reservation.count()).toBe(0);
    });

    it('précommande obligatoire et du même restaurant', async () => {
      await prisma.cartItem.deleteMany({ where: { cartId: 'cart-c1' } });
      await expect(book(1, 'a')).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_CART_EMPTY',
      );
      await prisma.cartItem.create({
        data: {
          cartId: 'cart-c1',
          productId: 'p2',
          variantId: 'var2',
          quantite: 1,
        },
      });
      await expect(book(1, 'b')).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_CART_OTHER_VENDOR',
      );
    });

    it('3 absences en 90 jours : 403 ; des absences plus anciennes ne comptent pas', async () => {
      const seedNoShow = async (daysAgo: number, i: number) => {
        const at = new Date(NOW.getTime() - daysAgo * DAY);
        await prisma.reservation.create({
          data: {
            restaurantId: 'v1',
            userId: 'c1',
            spaceId: 't1',
            status: 'NO_SHOW',
            partySize: 2,
            arrivalAt: at,
            endsAt: new Date(at.getTime() + 90 * MIN),
            occupiedUntil: new Date(at.getTime() + 105 * MIN),
            contactPhone: '061234561',
            requestKey: `old-${i}`,
            responseDeadlineAt: at,
            noShowAt: at,
          },
        });
      };
      await seedNoShow(100, 1);
      await seedNoShow(95, 2);
      await seedNoShow(5, 3);
      await expect(book(1, 'a')).resolves.toMatchObject({ status: 'PENDING' });
      await seedNoShow(3, 4);
      await seedNoShow(1, 5);
      await expect(book(1, 'b', { time: '14:00' })).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_RESTRICTED',
      );
    });
  });

  describe('disponibilités', () => {
    it('sans date : les bornes ; avec date : seulement les heures libres', async () => {
      await expect(booking.availability('v1', {}, NOW)).resolves.toMatchObject({
        maxPartySize: 8,
        firstDate: '2026-10-19',
        lastDate: '2026-11-18',
      });
      const times = (x: object) =>
        'slots' in x ? (x.slots as { time: string }[]).map((s) => s.time) : [];
      const before = await booking.availability('v1', { date: DATE }, NOW);
      expect(times(before)).toEqual([
        '12:00',
        '12:30',
        '13:00',
        '13:30',
        '14:00',
      ]);
      await book(1, 'a');
      const after12 = await booking.availability('v1', { date: DATE }, NOW);
      // 12:00 + 90 + 15 = 13:45 : seule 14:00 reste libre sur l'unique table.
      expect(times(after12)).toEqual(['14:00']);
    });
  });

  describe('restaurant', () => {
    it('accepte : la table est tenue 15 min pour le paiement, le client est prévenu', async () => {
      const r = await book(1, 'a');
      const accepted = await vendor.accept('o1', r.id, after(5 * MIN));
      expect(accepted.status).toBe('AWAITING_PAYMENT');
      expect(new Date(accepted.paymentDeadlineAt as Date).getTime()).toBe(
        NOW.getTime() + 20 * MIN,
      );
      const notices = await outboxOf();
      expect(
        notices.map((n) => (n.payload as { notice: string }).notice),
      ).toEqual(['REQUESTED', 'ACCEPTED']);
      expect(notices[1].payload).toMatchObject({
        audience: 'CLIENT',
        recipientUserId: 'c1',
      });
    });

    it('accepter et refuser en même temps : un seul geste passe', async () => {
      const r = await book(1, 'a');
      const results = await Promise.allSettled([
        vendor.accept('o1', r.id, after(MIN)),
        vendor.decline('o1', r.id, { reason: 'FULLY_BOOKED' }, after(MIN)),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma.reservationEvent.count({ where: { reservationId: r.id } }),
      ).toBe(2);
    });

    it('un autre restaurant ne voit ni ne touche cette réservation (404)', async () => {
      const r = await book(1, 'a');
      await expect(vendor.get('o2', r.id, NOW)).rejects.toThrow(
        'Réservation introuvable.',
      );
      await expect(vendor.accept('o2', r.id, NOW)).rejects.toThrow(
        'Réservation introuvable.',
      );
      // Un autre client non plus.
      await expect(booking.getMine('c2', r.id)).rejects.toThrow(
        'Réservation introuvable.',
      );
    });

    it('un refus libère la table : un autre client la prend', async () => {
      const r = await book(1, 'a');
      await vendor.decline('o1', r.id, { reason: 'OTHER' }, after(MIN));
      await expect(book(2, 'b', {}, after(2 * MIN))).resolves.toMatchObject({
        status: 'PENDING',
        spaceLabel: 'Table 1',
      });
    });

    it('Premium échu : le restaurant répond encore aux demandes reçues (C7)', async () => {
      const r = await book(1, 'a');
      await prisma.vendorSubscription.deleteMany({});
      await expect(
        vendor.accept('o1', r.id, after(MIN)),
      ).resolves.toMatchObject({ status: 'AWAITING_PAYMENT' });
    });

    it('réattribue vers une table libre du même type ; refuse une table prise ou d’un autre type', async () => {
      await table('t2', 'Terrasse');
      await seats('s1', 'Comptoir', 10);
      const r = await book(1, 'a');
      const moved = await vendor.reassign('o1', r.id, 't2', after(MIN));
      expect(moved.space).toMatchObject({ id: 't2', label: 'Terrasse' });
      const notice = (await outboxOf()).pop();
      expect(notice?.payload).toMatchObject({
        notice: 'REASSIGNED',
        recipientUserId: 'c1',
        spaceLabel: 'Terrasse',
      });
      const ev = await prisma.reservationEvent.findFirst({
        where: { reservationId: r.id, reason: 'REASSIGNED' },
      });
      expect(ev).toMatchObject({ fromSpaceId: 't1', toSpaceId: 't2' });

      // t1 libérée : un second client la prend à la même heure.
      const other = await book(2, 'b', {}, after(2 * MIN));
      expect(other.spaceLabel).toBe('Table 1');
      // Ramener la première sur t1, désormais prise : refusé.
      await expect(
        vendor.reassign('o1', r.id, 't1', after(3 * MIN)),
      ).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_SPACE_INCOMPATIBLE',
      );
      // Une table vers un espace de places : refusé (même type seulement).
      await expect(
        vendor.reassign('o1', r.id, 's1', after(3 * MIN)),
      ).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_SPACE_INCOMPATIBLE',
      );
    });

    it('absence : pas avant arrivée + 15 min ; retrait possible ensuite', async () => {
      const r = await book(1, 'a');
      // Le paiement (4B-2) confirmera ; on pose l'état directement.
      await prisma.reservation.update({
        where: { id: r.id },
        data: { status: 'CONFIRMED', acceptedAt: NOW, confirmedAt: NOW },
      });
      await expect(
        vendor.markNoShow('o1', r.id, new Date(NOON.getTime() + 10 * MIN)),
      ).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_NO_SHOW_TOO_EARLY',
      );
      const absent = await vendor.markNoShow(
        'o1',
        r.id,
        new Date(NOON.getTime() + 20 * MIN),
      );
      expect(absent.status).toBe('NO_SHOW');
      expect(absent.allowedActions).toContain('undoNoShow');
      const back = await vendor.undoNoShow(
        'o1',
        r.id,
        new Date(NOON.getTime() + 60 * MIN),
      );
      expect(back).toMatchObject({ status: 'CONFIRMED', noShowAt: null });
    });
  });

  describe('retrait d’absence (revue C1)', () => {
    it('table redonnée entre-temps : le retrait est refusé, aucune double occupation', async () => {
      // Délai minimal court : une nouvelle demande peut chevaucher l'occupation
      // encore figée d'une réservation déclarée absente.
      await prisma.reservationSettings.update({
        where: { restaurantId: 'v1' },
        data: { minLeadMin: 30 },
      });
      const first = await book(1, 'a');
      await prisma.reservation.update({
        where: { id: first.id },
        data: { status: 'CONFIRMED', acceptedAt: NOW, confirmedAt: NOW },
      });
      const at1220 = new Date(NOON.getTime() + 20 * MIN);
      await vendor.markNoShow('o1', first.id, at1220);
      // 13:30 tombe dans [12:00, 13:45) de la première : table rendue libre
      // par l'absence, un autre client la prend (à plus de 60 min, OD-02).
      const second = await book(2, 'b', { time: '13:30' }, at1220);
      expect(second.spaceLabel).toBe('Table 1');

      await expect(
        vendor.undoNoShow('o1', first.id, new Date(at1220.getTime() + MIN)),
      ).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_CAPACITY_TAKEN',
      );
      const row = await prisma.reservation.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(row.status).toBe('NO_SHOW');
    });
  });

  describe('client', () => {
    it('annule sa demande : la table est libérée, le restaurant prévenu', async () => {
      const r = await book(1, 'a');
      await expect(booking.cancel('c2', r.id, after(MIN))).rejects.toThrow(
        'Réservation introuvable.',
      );
      const cancelled = await booking.cancel('c1', r.id, after(MIN));
      expect(cancelled).toMatchObject({
        status: 'CANCELLED_BY_CLIENT',
        allowedActions: [],
      });
      expect((await outboxOf()).pop()?.payload).toMatchObject({
        notice: 'CANCELLED_BY_CLIENT',
        audience: 'VENDOR',
        recipientUserId: 'o1',
      });
      await expect(book(2, 'b', {}, after(2 * MIN))).resolves.toMatchObject({
        status: 'PENDING',
      });
    });
  });

  describe('le temps', () => {
    it('expire une demande sans réponse : client et restaurant prévenus, table libérée', async () => {
      const r = await book(1, 'a');
      expect(await lifecycle.expireOverdue(after(29 * MIN))).toBe(0);
      expect(await lifecycle.expireOverdue(after(31 * MIN))).toBe(1);
      expect(await lifecycle.expireOverdue(after(32 * MIN))).toBe(0);
      const row = await prisma.reservation.findUniqueOrThrow({
        where: { id: r.id },
      });
      expect(row.status).toBe('EXPIRED');
      const notices = (await outboxOf()).slice(1);
      expect(
        notices.map((n) => (n.payload as { audience: string }).audience),
      ).toEqual(['CLIENT', 'VENDOR']);
    });

    it('expire une demande acceptée mais non payée (15 min)', async () => {
      const r = await book(1, 'a');
      await vendor.accept('o1', r.id, after(MIN));
      expect(await lifecycle.expireOverdue(after(15 * MIN))).toBe(0);
      expect(await lifecycle.expireOverdue(after(17 * MIN))).toBe(1);
      const last = (await outboxOf()).pop();
      expect(last?.payload).toMatchObject({
        notice: 'EXPIRED',
        audience: 'CLIENT',
        expiredFrom: 'AWAITING_PAYMENT',
      });
    });

    it('acceptation et expiration simultanées : une seule transition', async () => {
      const r = await book(1, 'a');
      // Le vendeur lit à 29:59, le cron passe à 30:01 : deux écritures en vol.
      await Promise.allSettled([
        vendor.accept('o1', r.id, new Date(NOW.getTime() + 30 * MIN - 1000)),
        lifecycle.expireOverdue(new Date(NOW.getTime() + 30 * MIN + 1000)),
      ]);
      const events = await prisma.reservationEvent.findMany({
        where: { reservationId: r.id },
      });
      expect(events).toHaveLength(2);
      const row = await prisma.reservation.findUniqueOrThrow({
        where: { id: r.id },
      });
      expect(['AWAITING_PAYMENT', 'EXPIRED']).toContain(row.status);
    });

    it('rappel 2 h avant, une seule fois ; récapitulatif du jour, une seule fois', async () => {
      const r = await book(1, 'a');
      await prisma.reservation.update({
        where: { id: r.id },
        data: {
          status: 'CONFIRMED',
          acceptedAt: NOW,
          confirmedAt: NOW,
        },
      });
      const twoHoursBefore = new Date(NOON.getTime() - 110 * MIN);
      expect(await lifecycle.sendReminders(twoHoursBefore)).toBe(1);
      expect(await lifecycle.sendReminders(twoHoursBefore)).toBe(0);

      const morning = new Date('2026-10-20T07:00:00Z');
      expect(await lifecycle.sendDailySummaries(morning)).toBe(1);
      expect(await lifecycle.sendDailySummaries(morning)).toBe(0);
      const summary = (await outboxOf()).pop();
      expect(summary).toMatchObject({ aggregateId: 'v1:2026-10-20' });
      expect(summary?.payload).toMatchObject({
        notice: 'DAILY_SUMMARY',
        recipientUserId: 'o1',
        count: 1,
      });
    });

    it('pas de rappel quand la confirmation tombe moins de 3 h avant', async () => {
      const r = await book(1, 'a');
      await prisma.reservation.update({
        where: { id: r.id },
        data: {
          status: 'CONFIRMED',
          acceptedAt: NOW,
          confirmedAt: new Date(NOON.getTime() - 150 * MIN),
        },
      });
      expect(
        await lifecycle.sendReminders(new Date(NOON.getTime() - 110 * MIN)),
      ).toBe(0);
      expect(
        (await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } }))
          .reminderSentAt,
      ).not.toBeNull();
    });
  });

  describe('lot P — plafonds par client (P-01, OD-01)', () => {
    const refill = (n: number) =>
      prisma.cartItem.create({
        data: {
          cartId: `cart-c${n}`,
          productId: 'p1',
          variantId: 'var1',
          quantite: 2,
        },
      });

    it('3ᵉ demande non payée → 409 RESERVATION_ACTIVE_LIMIT, rien d’écrit', async () => {
      await book(1, 'a');
      await refill(1);
      await book(1, 'b', { date: '2026-10-27' });
      await refill(1);
      await expect(book(1, 'c', { date: '2026-11-03' })).rejects.toSatisfy(
        (e: unknown) =>
          codeOf(e) === 'RESERVATION_ACTIVE_LIMIT' &&
          (e as { getResponse: () => { limit: string } }).getResponse()
            .limit === 'unpaid',
      );
      expect(await prisma.reservation.count({ where: { userId: 'c1' } })).toBe(
        2,
      );
      // Le panier n'est pas vidé par un refus.
      expect(
        await prisma.cartItem.count({ where: { cartId: 'cart-c1' } }),
      ).toBe(1);
    });

    it('une seule réservation par restaurant et par jour', async () => {
      await table('t2', 'Table 2');
      await book(1, 'a');
      await refill(1);
      await expect(book(1, 'b', { time: '13:00' })).rejects.toSatisfy(
        (e: unknown) =>
          codeOf(e) === 'RESERVATION_ACTIVE_LIMIT' &&
          (e as { getResponse: () => { limit: string } }).getResponse()
            .limit === 'perRestaurantPerDay',
      );
    });

    it('la place se libère au refus du restaurant', async () => {
      const first = await book(1, 'a');
      await refill(1);
      await book(1, 'b', { date: '2026-10-27' });
      await vendor.decline(
        'o1',
        first.id,
        { reason: 'FULLY_BOOKED' } as never,
        after(MIN),
      );
      await refill(1);
      await expect(book(1, 'c', { date: '2026-11-03' })).resolves.toMatchObject(
        { status: 'PENDING' },
      );
    });

    it('3 réservations confirmées à venir : la 4ᵉ est refusée', async () => {
      for (const [i, date] of [
        '2026-10-20',
        '2026-10-27',
        '2026-11-03',
      ].entries()) {
        if (i > 0) await refill(1);
        const r = await book(1, `k${i}`, { date });
        await prisma.reservation.update({
          where: { id: r.id },
          data: { status: 'CONFIRMED', acceptedAt: NOW, confirmedAt: NOW },
        });
      }
      await refill(1);
      await expect(book(1, 'k4', { date: '2026-11-10' })).rejects.toSatisfy(
        (e: unknown) =>
          (e as { getResponse: () => { limit: string } }).getResponse()
            .limit === 'upcomingConfirmed',
      );
    });

    it('concurrence : deux demandes simultanées au plafond — une seule passe, l’autre bute sur le plafond', async () => {
      await book(1, 'a');
      await refill(1);
      const results = await Promise.allSettled([
        book(1, 'b', { date: '2026-10-27' }),
        book(1, 'c', { date: '2026-11-03' }),
      ]);
      const passed = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(passed).toHaveLength(1);
      expect(refused).toHaveLength(1);
      // Sans le verrou client, les deux compteraient 1 et la seconde
      // échouerait plus loin (panier changé) : le code prouve le verrou.
      expect(codeOf(refused[0].reason)).toBe('RESERVATION_ACTIVE_LIMIT');
      expect(await prisma.reservation.count({ where: { userId: 'c1' } })).toBe(
        2,
      );
    });

    it('même clé envoyée deux fois en même temps : la même réservation, aucune erreur (revue H1)', async () => {
      const results = await Promise.allSettled([
        book(1, 'same'),
        book(1, 'same'),
        book(1, 'same'),
      ]);
      // Avant le correctif, le second butait sur le plafond « 1 par jour »
      // écrit par le premier : 409 alors que la réservation existait.
      expect(results.map((r) => r.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ]);
      const ids = results.map(
        (r) => (r as PromiseFulfilledResult<{ id: string }>).value.id,
      );
      expect(new Set(ids).size).toBe(1);
      expect(await prisma.reservation.count()).toBe(1);
      expect(await outboxOf()).toHaveLength(1);
    });
  });

  describe('lot P — bornes et heure d’arrivée (P-03, P-05)', () => {
    it('aucune arrivée proposée à moins de 60 min, même avec minLeadMin = 30', async () => {
      await prisma.reservationSettings.update({
        where: { restaurantId: 'v1' },
        data: { minLeadMin: 30 },
      });
      // 20/10 11:15 à Brazzaville : 12:00 est à 45 min, 12:30 à 75 min.
      const now = new Date('2026-10-20T10:15:00Z');
      const day = await booking.availability(
        'v1',
        { date: DATE, partySize: 2 } as never,
        now,
      );
      const times = (day as { slots: { time: string }[] }).slots.map(
        (s) => s.time,
      );
      expect(times).not.toContain('12:00');
      expect(times).toContain('12:30');
      expect(day).toMatchObject({ minLeadMin: 60 });
      await expect(book(1, 'a', { time: '12:00' }, now)).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_SLOT_UNAVAILABLE',
      );
    });

    it('échéances : réponse ≤ arrivée − 30, paiement ≤ arrivée − 10', async () => {
      const r = await book(1, 'a');
      const accepted = await vendor.accept('o1', r.id, after(5 * MIN));
      const row = await prisma.reservation.findUniqueOrThrow({
        where: { id: r.id },
      });
      expect(row.responseDeadlineAt.getTime()).toBeLessThanOrEqual(
        NOON.getTime() - 30 * MIN,
      );
      expect(row.paymentDeadlineAt!.getTime()).toBeLessThanOrEqual(
        NOON.getTime() - 10 * MIN,
      );
      expect(accepted.status).toBe('AWAITING_PAYMENT');
    });

    it('plat du midi précommandé le matin : jugé à l’heure d’arrivée, accepté', async () => {
      await prisma.product.update({
        where: { id: 'p1' },
        data: { availableFrom: '11:30', availableUntil: '14:30' },
      });
      // NOW = 10:00 : hors fenêtre maintenant, dans la fenêtre à 12:00.
      await expect(book(1, 'a')).resolves.toMatchObject({ status: 'PENDING' });
    });

    it('plat du soir pour une arrivée à midi : refusé', async () => {
      await prisma.product.update({
        where: { id: 'p1' },
        data: { availableFrom: '18:00', availableUntil: '23:00' },
      });
      await expect(book(1, 'a')).rejects.toMatchObject({ status: 400 });
      expect(await prisma.reservation.count()).toBe(0);
    });

    it('quota du jour épuisé : arrivée un autre jour acceptée, le jour même refusée (OD-11)', async () => {
      await prisma.product.update({
        where: { id: 'p1' },
        data: {
          stockPolicy: 'DAILY_QUOTA',
          stockQuotidien: 5,
          stockRestant: 0,
        },
      });
      await expect(book(1, 'a')).resolves.toMatchObject({ status: 'PENDING' });
      // Le 20/10 à 10:00 locale, pour 12:00 le même jour.
      await expect(
        book(2, 'b', {}, new Date('2026-10-20T09:00:00Z')),
      ).rejects.toSatisfy((e: unknown) => codeOf(e) === 'OUT_OF_STOCK');
    });
  });

  describe('lot P — la configuration ne retire pas une table occupée (P-02, OD-17)', () => {
    const saveConfig = async (
      t1: Record<string, unknown>,
      extra: Record<string, unknown>[] = [],
      maxPartySize = 4,
    ) => {
      const { version } = await prisma.reservationSettings.findUniqueOrThrow({
        where: { restaurantId: 'v1' },
      });
      return config.save(
        'o1',
        {
          version,
          enabled: true,
          slotDurationMin: 90,
          slotStepMin: 30,
          bufferMin: 15,
          minLeadMin: 120,
          maxAdvanceDays: 30,
          maxPartySize,
          spaces: [
            { id: 't1', kind: 'TABLE', label: 'Table 1', ...t1 },
            ...extra,
          ],
          windows: [
            { dayOfWeek: 'MARDI', startTime: '12:00', endTime: '14:00' },
          ],
        } as never,
        NOW,
      );
    };

    it('archiver une table qui porte une demande → 409, rien d’écrit', async () => {
      await book(1, 'a');
      const before = await prisma.reservationSettings.findUniqueOrThrow({
        where: { restaurantId: 'v1' },
      });
      await expect(
        saveConfig({ archived: true }, [
          { kind: 'TABLE', label: 'Table 2', minGuests: 1, maxGuests: 4 },
        ]),
      ).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_SPACE_IN_USE',
      );
      const after = await prisma.reservationSettings.findUniqueOrThrow({
        where: { restaurantId: 'v1' },
      });
      expect(after.version).toBe(before.version);
      expect(
        (
          await prisma.reservationSpace.findUniqueOrThrow({
            where: { id: 't1' },
          })
        ).archivedAt,
      ).toBeNull();
      expect(await prisma.reservationSpace.count()).toBe(1);
    });

    it('réduire une table sous la taille du groupe → 409 ; une réduction tenable passe', async () => {
      await book(1, 'a', { partySize: 3 });
      await expect(
        saveConfig({ minGuests: 1, maxGuests: 2 }, [], 2),
      ).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_SPACE_IN_USE',
      );
      await expect(
        saveConfig({ minGuests: 1, maxGuests: 3 }, [], 3),
      ).resolves.toBeDefined();
    });

    it('espace partagé : réduire de 8 à 4 places avec 6 tenues → 409', async () => {
      await seats('s1', 'Comptoir', 8);
      await prisma.reservationSpace.update({
        where: { id: 't1' },
        data: { archivedAt: NOW },
      });
      await book(1, 'a', { partySize: 3 });
      await book(2, 'b', { partySize: 3 });
      const { version } = await prisma.reservationSettings.findUniqueOrThrow({
        where: { restaurantId: 'v1' },
      });
      await expect(
        config.save(
          'o1',
          {
            version,
            enabled: true,
            slotDurationMin: 90,
            slotStepMin: 30,
            bufferMin: 15,
            minLeadMin: 120,
            maxAdvanceDays: 30,
            maxPartySize: 4,
            spaces: [
              { id: 't1', kind: 'TABLE', label: 'Table 1', archived: true },
              {
                id: 's1',
                kind: 'SEATS',
                label: 'Comptoir',
                seatCount: 4,
                maxSeatsPerBooking: 4,
              },
            ],
            windows: [
              { dayOfWeek: 'MARDI', startTime: '12:00', endTime: '14:00' },
            ],
          } as never,
          NOW,
        ),
      ).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_SPACE_IN_USE',
      );
    });

    it('table libérée (demande refusée) : l’archivage passe', async () => {
      const r = await book(1, 'a');
      await vendor.decline(
        'o1',
        r.id,
        { reason: 'FULLY_BOOKED' } as never,
        after(MIN),
      );
      await expect(
        saveConfig({ archived: true }, [
          { kind: 'TABLE', label: 'Table 2', minGuests: 1, maxGuests: 4 },
        ]),
      ).resolves.toBeDefined();
    });
  });

  describe('contraintes en base', () => {
    const insert = (data: Record<string, unknown>) =>
      prisma.reservation.create({
        data: {
          restaurantId: 'v1',
          userId: 'c1',
          spaceId: 't1',
          partySize: 2,
          arrivalAt: NOON,
          endsAt: new Date(NOON.getTime() + 90 * MIN),
          occupiedUntil: new Date(NOON.getTime() + 105 * MIN),
          contactPhone: '061234561',
          requestKey: `raw-${Math.random()}`,
          responseDeadlineAt: NOW,
          ...data,
        } as never,
      });

    it('refuse un statut inconnu, un refus sans motif, une absence sans date', async () => {
      await expect(insert({ status: 'BOGUS' })).rejects.toThrow();
      await expect(insert({ status: 'DECLINED' })).rejects.toThrow();
      await expect(
        insert({ status: 'DECLINED', declineReason: 'NOPE' }),
      ).rejects.toThrow();
      await expect(insert({ status: 'NO_SHOW' })).rejects.toThrow();
      await expect(insert({ partySize: 0 })).rejects.toThrow();
      await expect(
        insert({ responseDeadlineAt: new Date(NOON.getTime() + MIN) }),
      ).rejects.toThrow();
      await expect(
        insert({ status: 'DECLINED', declineReason: 'FULLY_BOOKED' }),
      ).resolves.toBeDefined();
    });

    it('une table réservée ne se supprime pas (RESTRICT)', async () => {
      await book(1, 'a');
      await expect(
        prisma.reservationSpace.delete({ where: { id: 't1' } }),
      ).rejects.toThrow();
    });
  });
});
