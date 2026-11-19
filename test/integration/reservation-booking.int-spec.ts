import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient } from '@prisma/client';

import { OrderCalculatorService } from '../../apps/lilia-app/src/modules/orders/order-calculator.service';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { OrderValidatorService } from '../../apps/lilia-app/src/modules/orders/order-validator.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { LedgerPosterService } from '../../apps/lilia-app/src/modules/ledger/ledger-poster.service';
import { LedgerService } from '../../apps/lilia-app/src/modules/ledger/ledger.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { PaymentService } from '../../apps/lilia-app/src/modules/payments/services/payment.service';
import { RefundsService } from '../../apps/lilia-app/src/modules/refunds/refunds.service';
import { ReservationAdminService } from '../../apps/lilia-app/src/modules/reservations/reservation-admin.service';
import { ReservationBookingService } from '../../apps/lilia-app/src/modules/reservations/reservation-booking.service';
import { ReservationLifecycleService } from '../../apps/lilia-app/src/modules/reservations/reservation-lifecycle.service';
import { ReservationOrderRelease } from '../../apps/lilia-app/src/modules/reservations/reservation-order-release';
import { ReservationOrderService } from '../../apps/lilia-app/src/modules/reservations/reservation-order.service';
import { ReservationPaymentService } from '../../apps/lilia-app/src/modules/reservations/reservation-payment.service';
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
        // 4B-2 — ce que lit le chiffrage de la commande liée.
        modifiersEnabled: true,
        serviceFeePercent: 15,
        groceryServiceFeeBps: null,
        restaurantCommissionPercent: 10,
      }),
    };
    const outbox = new OutboxService(prisma as never);
    // Seuls `validateAndGetUser` et `validateStock` servent : ni promo ni
    // ouverture n'y sont lues.
    const validator = new OrderValidatorService(
      prisma as never,
      null as never,
      null as never,
    );
    const release = new ReservationOrderRelease(
      new OrderTransitionService(),
      new StockService(),
    );
    booking = new ReservationBookingService(
      prisma as never,
      outbox,
      new VendorSubscriptionService(prisma as never, settings as never),
      settings as never,
      validator,
      release,
    );
    vendor = new ReservationVendorService(
      prisma as never,
      outbox,
      new ReservationOrderService(
        prisma as never,
        validator,
        new OrderCalculatorService(),
        new StockService(),
        new OrderTransitionService(),
        settings as never,
      ),
      release,
    );
    lifecycle = new ReservationLifecycleService(
      prisma as never,
      outbox,
      release,
    );
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

    it('3 absences en 90 jours, de 2 restaurants : 403 ; un seul restaurant ou des absences anciennes ne suffisent pas (R-ABS)', async () => {
      const seedNoShow = async (
        daysAgo: number,
        i: number,
        restaurantId = 'v1',
      ) => {
        const at = new Date(NOW.getTime() - daysAgo * DAY);
        await prisma.reservation.create({
          data: {
            restaurantId,
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
            createdAt: at,
          },
        });
      };
      await seedNoShow(100, 1);
      await seedNoShow(95, 2);
      await seedNoShow(5, 3);
      await seedNoShow(3, 4);
      await seedNoShow(1, 5);
      // Trois absences récentes, toutes déclarées par v1 : pas de restriction.
      const ok = await book(1, 'a');
      expect(ok).toMatchObject({ status: 'PENDING' });
      await prisma.reservationEvent.deleteMany({
        where: { reservationId: ok.id },
      });
      await prisma.reservation.delete({ where: { id: ok.id } });
      await prisma.cartItem.create({
        data: {
          cartId: 'cart-c1',
          productId: 'p1',
          variantId: 'var1',
          quantite: 2,
        },
      });
      // Une absence déclarée par un second restaurant : restriction.
      await seedNoShow(2, 6, 'v2');
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
      // 25 h plus tard : hors de la fenêtre R-SPAM (2 créations / restaurant / 24 h).
      await expect(
        book(1, 'c', { date: '2026-11-03' }, after(25 * 60 * MIN)),
      ).resolves.toMatchObject({ status: 'PENDING' });
    });

    it('3 réservations confirmées à venir : la 4ᵉ est refusée', async () => {
      const later = after(25 * 60 * MIN);
      for (const [i, date] of [
        '2026-10-20',
        '2026-10-27',
        '2026-11-03',
      ].entries()) {
        if (i > 0) await refill(1);
        // La 3ᵉ, 25 h plus tard : hors de la fenêtre R-SPAM.
        const r = await book(1, `k${i}`, { date }, i < 2 ? NOW : later);
        await prisma.reservation.update({
          where: { id: r.id },
          data: { status: 'CONFIRMED', acceptedAt: NOW, confirmedAt: NOW },
        });
      }
      await refill(1);
      await expect(
        book(1, 'k4', { date: '2026-11-10' }, later),
      ).rejects.toSatisfy(
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

    it('R-SPAM : créer puis annuler en boucle — la 3ᵉ demande du jour chez le même restaurant est refusée', async () => {
      const a = await book(1, 'a');
      await booking.cancel('c1', a.id, after(MIN));
      await refill(1);
      const b = await book(1, 'b', { date: '2026-10-27' });
      await booking.cancel('c1', b.id, after(MIN));
      await refill(1);
      await expect(book(1, 'c', { date: '2026-11-03' })).rejects.toSatisfy(
        (e: unknown) =>
          codeOf(e) === 'RESERVATION_CREATION_LIMIT' &&
          (e as { getResponse: () => { limit: string } }).getResponse()
            .limit === 'perRestaurant',
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

  describe('4B-2 — commande liée à l’acceptation (J2, OD-03, I-01)', () => {
    /** 20/10 à 08:00 locale : une arrivée à 12:00 le même jour. */
    const SAME_DAY_NOW = new Date('2026-10-20T07:00:00Z');

    const linkedOrder = (reservationId: string) =>
      prisma.order.findUnique({
        where: { reservationId },
        include: { items: true },
      });

    it('instantané indicatif à la demande (P-04) : part de chaque ligne et sous-total', async () => {
      const r = await book(1, 'a');
      expect(r.items).toEqual([
        expect.objectContaining({ indicativeLineTotal: 10_000 }),
      ]);
      expect(r.payment).toBeNull();
      const row = await prisma.reservation.findUniqueOrThrow({
        where: { id: r.id },
      });
      expect(row.indicativeSubTotal).toBe(10_000);
    });

    it('accepte : commande EN_ATTENTE déjà acceptée, payable jusqu’à l’échéance, au montant du serveur', async () => {
      await prisma.product.update({
        where: { id: 'p1' },
        data: { stockPolicy: 'INVENTORY', stockRestant: 10 },
      });
      const r = await book(1, 'a');
      const accepted = await vendor.accept('o1', r.id, after(5 * MIN));

      const order = await linkedOrder(r.id);
      expect(order).toMatchObject({
        userId: 'c1',
        restaurantId: 'v1',
        status: 'EN_ATTENTE',
        orderFlow: 'ACCEPT_FIRST',
        isDelivery: false,
        isPreorder: true,
        subTotal: 10_000,
        deliveryFee: 0,
        serviceFee: 1_500,
        discountAmount: 0,
        total: 11_500,
        commissionPercent: 10,
        commissionAmount: 1_000,
        contactPhone: '061234561',
      });
      expect(order!.acceptedAt!.getTime()).toBe(after(5 * MIN).getTime());
      expect(order!.paymentDueAt!.getTime()).toBe(
        new Date(accepted.paymentDeadlineAt as Date).getTime(),
      );
      expect(order!.scheduledFor!.getTime()).toBe(NOON.getTime());
      expect(order!.items).toEqual([
        expect.objectContaining({
          productId: 'p1',
          variantId: 'var1',
          quantite: 2,
          prix: 5_000,
          snapshotPrice: 5_000,
          // OD-11 : arrivée un autre jour, rien pris au stock du jour.
          stockUnitsReserved: 0,
        }),
      ]);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: 'p1' } }))
          .stockRestant,
      ).toBe(10);
      expect(
        await prisma.orderHistory.findMany({ where: { orderId: order!.id } }),
      ).toEqual([
        expect.objectContaining({
          fromStatus: null,
          toStatus: 'EN_ATTENTE',
          actionId: 'RESTAURATEUR',
          actorUserId: 'o1',
        }),
      ]);
      expect(accepted.payment).toEqual({
        orderId: order!.id,
        orderStatus: 'EN_ATTENTE',
        subTotal: 10_000,
        serviceFee: 1_500,
        total: 11_500,
        indicativeSubTotal: 10_000,
        priceChanged: false,
      });
      const notices = await outboxOf();
      expect(notices[1].payload).toMatchObject({
        notice: 'ACCEPTED',
        totalXaf: 11_500,
        priceChanged: false,
      });
      // Rien du panier n'est touché : il a été vidé à la demande.
      expect(await prisma.payment.count()).toBe(0);
    });

    it('prix changé entre la demande et l’acceptation : nouveau montant, écart signalé (OD-04)', async () => {
      const r = await book(1, 'a');
      await prisma.productVariant.update({
        where: { id: 'var1' },
        data: { prix: 6_000 },
      });
      const accepted = await vendor.accept('o1', r.id, after(MIN));
      expect(accepted.payment).toMatchObject({
        subTotal: 12_000,
        total: 13_800,
        indicativeSubTotal: 10_000,
        priceChanged: true,
      });
      expect(accepted.items[0].indicativeLineTotal).toBe(10_000);
      const notices = await outboxOf();
      expect(notices[1].payload).toMatchObject({ priceChanged: true });
    });

    it.each([
      ['indisponible', { isAvailable: false }],
      ['supprimé', { deletedAt: NOW }],
    ])(
      'plat %s : 409 nominatif, rien d’écrit, le restaurant peut encore refuser',
      async (_label, data) => {
        const r = await book(1, 'a');
        await prisma.product.update({ where: { id: 'p1' }, data });
        await expect(vendor.accept('o1', r.id, after(MIN))).rejects.toSatisfy(
          (e: unknown) => codeOf(e) === 'RESERVATION_ITEMS_UNAVAILABLE',
        );
        expect(await prisma.order.count()).toBe(0);
        const row = await prisma.reservation.findUniqueOrThrow({
          where: { id: r.id },
        });
        expect(row.status).toBe('PENDING');
        expect(await outboxOf()).toHaveLength(1);
        await expect(
          vendor.decline(
            'o1',
            r.id,
            { reason: 'ITEMS_UNAVAILABLE' },
            after(2 * MIN),
          ),
        ).resolves.toMatchObject({ status: 'DECLINED' });
      },
    );

    it('plat retiré de la carte (ligne supprimée) : 409 qui le nomme', async () => {
      const r = await book(1, 'a');
      // Les paniers des autres clients portent encore ce plat.
      await prisma.cartItem.deleteMany({});
      await prisma.productVariant.delete({ where: { id: 'var1' } });
      await prisma.product.delete({ where: { id: 'p1' } });
      await expect(vendor.accept('o1', r.id, after(MIN))).rejects.toSatisfy(
        (e: unknown) =>
          codeOf(e) === 'RESERVATION_ITEMS_UNAVAILABLE' &&
          JSON.stringify(
            (e as { getResponse(): unknown }).getResponse(),
          ).includes('Poulet DG 1'),
      );
      expect(await prisma.order.count()).toBe(0);
    });

    it('arrivée le jour même : le stock du jour est pris et figé ; épuisé entre-temps → 409, rien d’écrit', async () => {
      await prisma.product.update({
        where: { id: 'p1' },
        data: {
          stockPolicy: 'DAILY_QUOTA',
          stockQuotidien: 10,
          stockRestant: 10,
        },
      });
      const r = await book(1, 'a', {}, SAME_DAY_NOW);
      await vendor.accept('o1', r.id, new Date(SAME_DAY_NOW.getTime() + MIN));
      const order = await linkedOrder(r.id);
      expect(order!.items[0].stockUnitsReserved).toBe(2);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: 'p1' } }))
          .stockRestant,
      ).toBe(8);

      await table('t2', 'Table 2');
      const r2 = await book(2, 'b', {}, SAME_DAY_NOW);
      await prisma.product.update({
        where: { id: 'p1' },
        data: { stockRestant: 1 },
      });
      await expect(
        vendor.accept('o1', r2.id, new Date(SAME_DAY_NOW.getTime() + MIN)),
      ).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_ITEMS_UNAVAILABLE',
      );
      expect(await prisma.order.count()).toBe(1);
      expect(
        (await prisma.reservation.findUniqueOrThrow({ where: { id: r2.id } }))
          .status,
      ).toBe('PENDING');
    });

    it('deux acceptations simultanées : une seule transition, une seule commande', async () => {
      const r = await book(1, 'a');
      const results = await Promise.allSettled([
        vendor.accept('o1', r.id, after(MIN)),
        vendor.accept('o1', r.id, after(MIN)),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.order.count()).toBe(1);
      expect(
        await prisma.reservationEvent.count({
          where: { reservationId: r.id, toStatus: 'AWAITING_PAYMENT' },
        }),
      ).toBe(1);
      expect(
        (await outboxOf()).filter(
          (n) => (n.payload as { notice: string }).notice === 'ACCEPTED',
        ),
      ).toHaveLength(1);
    });
  });

  describe('4B-2 — réservation non payée : la commande liée suit (J4/J5, OD-05)', () => {
    /** 20/10 à 08:00 locale, arrivée à 12:00 le même jour (stock du jour pris). */
    const T0 = new Date('2026-10-20T07:00:00Z');
    const at = (min: number) => new Date(T0.getTime() + min * MIN);

    const acceptedSameDay = async () => {
      await prisma.product.update({
        where: { id: 'p1' },
        data: {
          stockPolicy: 'DAILY_QUOTA',
          stockQuotidien: 10,
          stockRestant: 10,
        },
      });
      const r = await book(1, 'a', {}, T0);
      await vendor.accept('o1', r.id, at(1));
      const order = await prisma.order.findUniqueOrThrow({
        where: { reservationId: r.id },
      });
      return { r, order };
    };

    /** Une tentative telle que `PaymentService` l'écrit avant d'appeler pawaPay. */
    const pendingPayment = (orderId: string, createdAt: Date) =>
      prisma.payment.create({
        data: {
          orderId,
          amount: 11_500,
          currency: 'XAF',
          phoneNumber: '061234561',
          method: 'MTN_MOMO',
          status: 'PENDING',
          provider: 'PAWAPAY',
          providerTransactionId: `ptx-${orderId}`,
          metadata: {},
          createdAt,
        },
      });

    const state = async (reservationId: string, orderId: string) => ({
      reservation: (
        await prisma.reservation.findUniqueOrThrow({
          where: { id: reservationId },
        })
      ).status,
      order: (await prisma.order.findUniqueOrThrow({ where: { id: orderId } }))
        .status,
      stock: (await prisma.product.findUniqueOrThrow({ where: { id: 'p1' } }))
        .stockRestant,
    });

    it('expiration sans paiement : réservation EXPIRED, commande ANNULER, stock rendu, une transaction', async () => {
      const { r, order } = await acceptedSameDay();
      expect((await state(r.id, order.id)).stock).toBe(8);
      expect(await lifecycle.expireOverdue(at(17))).toBe(1);
      expect(await state(r.id, order.id)).toEqual({
        reservation: 'EXPIRED',
        order: 'ANNULER',
        stock: 10,
      });
      expect(
        await prisma.orderHistory.findFirst({
          where: { orderId: order.id, toStatus: 'ANNULER' },
        }),
      ).toMatchObject({
        fromStatus: 'EN_ATTENTE',
        actionId: 'SYSTEM',
        source: 'CRON',
      });
      // Le client ne peut plus payer : la commande n'est plus EN_ATTENTE.
    });

    it('grâce : une tentative en cours retient l’expiration 17 min, puis la commande et la tentative sont closes', async () => {
      const { r, order } = await acceptedSameDay();
      // Tentative à 14 min, échéance de paiement à 16 min (acceptation + 15).
      await pendingPayment(order.id, at(14));
      expect(await lifecycle.expireOverdue(at(20))).toBe(0);
      expect(await lifecycle.expireOverdue(at(30))).toBe(0);
      expect((await state(r.id, order.id)).reservation).toBe(
        'AWAITING_PAYMENT',
      );
      expect(await lifecycle.expireOverdue(at(32))).toBe(1);
      expect(await state(r.id, order.id)).toMatchObject({
        reservation: 'EXPIRED',
        order: 'ANNULER',
      });
      expect(
        (
          await prisma.payment.findFirstOrThrow({
            where: { orderId: order.id },
          })
        ).status,
      ).toBe('CANCELLED');
    });

    it('grâce jamais après l’arrivée', async () => {
      const { r, order } = await acceptedSameDay();
      // Arrivée à 12:00 locale = T0 + 240 min.
      await pendingPayment(order.id, at(235));
      expect(await lifecycle.expireOverdue(at(239))).toBe(0);
      expect(await lifecycle.expireOverdue(at(240))).toBe(1);
      expect((await state(r.id, order.id)).reservation).toBe('EXPIRED');
    });

    it('commande payée à l’instant (EN_ATTENTE quittée) : l’expiration ne touche à rien', async () => {
      const { r, order } = await acceptedSameDay();
      // État que posera la confirmation du paiement (J3) — écrit ici à la
      // main, avant que l'accroche n'existe.
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'PAYER' },
      });
      expect(await lifecycle.expireOverdue(at(17))).toBe(0);
      expect((await state(r.id, order.id)).reservation).toBe(
        'AWAITING_PAYMENT',
      );
    });

    it('le client annule une réservation acceptée : commande ANNULER, stock rendu ; paiement en cours → 409, rien ne bouge', async () => {
      const { r, order } = await acceptedSameDay();
      const payment = await pendingPayment(order.id, at(2));
      await expect(booking.cancel('c1', r.id, at(3))).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === 'RESERVATION_PAYMENT_IN_PROGRESS',
      );
      expect(await state(r.id, order.id)).toEqual({
        reservation: 'AWAITING_PAYMENT',
        order: 'EN_ATTENTE',
        stock: 8,
      });
      // Le prestataire a refusé : l'annulation passe.
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED' },
      });
      await booking.cancel('c1', r.id, at(4));
      expect(await state(r.id, order.id)).toEqual({
        reservation: 'CANCELLED_BY_CLIENT',
        order: 'ANNULER',
        stock: 10,
      });
    });

    it('le restaurant annule une réservation acceptée : la commande suit', async () => {
      const { r, order } = await acceptedSameDay();
      await vendor.cancel('o1', r.id, { reason: 'CLOSED_UNEXPECTEDLY' }, at(3));
      expect(await state(r.id, order.id)).toEqual({
        reservation: 'CANCELLED_BY_VENDOR',
        order: 'ANNULER',
        stock: 10,
      });
    });

    it('annulation client et expiration simultanées : une seule issue, une seule annulation de commande', async () => {
      const { r, order } = await acceptedSameDay();
      await Promise.allSettled([
        booking.cancel('c1', r.id, at(17)),
        lifecycle.expireOverdue(at(17)),
      ]);
      expect((await state(r.id, order.id)).order).toBe('ANNULER');
      expect(
        await prisma.orderHistory.count({
          where: { orderId: order.id, toStatus: 'ANNULER' },
        }),
      ).toBe(1);
      expect((await state(r.id, order.id)).stock).toBe(10);
    });
  });

  describe('4B-2 — paiement et confirmation (J3, règle 3)', () => {
    const T0 = new Date('2026-10-20T07:00:00Z');
    const at = (min: number) => new Date(T0.getTime() + min * MIN);
    const transitions = new OrderTransitionService();

    const accepted = async () => {
      const r = await book(1, 'a', {}, T0);
      await vendor.accept('o1', r.id, at(1));
      const order = await prisma.order.findUniqueOrThrow({
        where: { reservationId: r.id },
      });
      return { r, order };
    };

    /** Ce que fait `PaymentService.confirmCollection` au verdict SUCCESS. */
    const confirmPayment = (orderId: string) =>
      prisma.$transaction((tx) =>
        transitions.tryTransition(tx as never, {
          orderId,
          from: 'EN_ATTENTE',
          to: 'PAYER',
          actor: 'SYSTEM',
          source: 'WEBHOOK',
          data: { paidAt: at(5) },
        }),
      );

    const noticesOf = async (notice: string) =>
      (await outboxOf()).filter(
        (n) => (n.payload as { notice: string }).notice === notice,
      );

    it('paiement confirmé : commande PAYER (déjà acceptée, sans échéance d’acceptation), réservation CONFIRMED, journal et deux avis — une transaction', async () => {
      const { r, order } = await accepted();
      await expect(confirmPayment(order.id)).resolves.toEqual({ moved: true });
      const o = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(o.status).toBe('PAYER');
      expect(o.acceptedAt).not.toBeNull();
      expect(o.acceptDeadlineAt).toBeNull();
      const row = await prisma.reservation.findUniqueOrThrow({
        where: { id: r.id },
      });
      expect(row.status).toBe('CONFIRMED');
      expect(row.confirmedAt).not.toBeNull();
      expect(
        await prisma.reservationEvent.findFirst({
          where: { reservationId: r.id, toStatus: 'CONFIRMED' },
        }),
      ).toMatchObject({ actorRole: 'SYSTEM', reason: 'PAYMENT_CONFIRMED' });
      expect(await noticesOf('CONFIRMED')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            audience: 'CLIENT',
            recipientUserId: 'c1',
          }),
        }),
      ]);
      expect(await noticesOf('PAID')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            audience: 'VENDOR',
            recipientUserId: 'o1',
          }),
        }),
      ]);
      const view = await booking.getMine('c1', r.id);
      expect(view.allowedActions).not.toContain('pay');
    });

    it('trois confirmations simultanées (webhook, interrogation, cron) : une seule transition, un seul jeu d’avis', async () => {
      const { r, order } = await accepted();
      const results = await Promise.all([
        confirmPayment(order.id),
        confirmPayment(order.id),
        confirmPayment(order.id),
      ]);
      expect(results.filter((x) => x.moved)).toHaveLength(1);
      expect(
        await prisma.reservationEvent.count({
          where: { reservationId: r.id, toStatus: 'CONFIRMED' },
        }),
      ).toBe(1);
      expect(await noticesOf('CONFIRMED')).toHaveLength(1);
      expect(await noticesOf('PAID')).toHaveLength(1);
    });

    it('réservation qui n’attend plus son paiement (invariant rompu) : la commande ne passe pas PAYER, rien n’est forcé', async () => {
      const { r, order } = await accepted();
      // État qu'aucun parcours ne produit (l'annulation emporte la commande) :
      // posé à la main pour prouver le garde-fou.
      await prisma.reservation.update({
        where: { id: r.id },
        data: { status: 'EXPIRED', expiredAt: at(2) },
      });
      await expect(confirmPayment(order.id)).resolves.toEqual({ moved: false });
      // Remise en EN_ATTENTE dans la même transaction : rien de la tentative
      // de passage à PAYER ne subsiste.
      const o = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(o.status).toBe('EN_ATTENTE');
      expect(o.paidAt).toBeNull();
      expect(
        await prisma.orderHistory.count({
          where: { orderId: order.id, toStatus: 'PAYER' },
        }),
      ).toBe(0);
      expect(await noticesOf('CONFIRMED')).toHaveLength(0);
    });

    it('réservation expirée par le cron puis SUCCESS tardif : réservation jamais réactivée', async () => {
      const { r, order } = await accepted();
      await lifecycle.expireOverdue(at(17));
      await expect(confirmPayment(order.id)).resolves.toEqual({ moved: false });
      expect(
        (await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } }))
          .status,
      ).toBe('EXPIRED');
    });

    describe('POST /reservations/:id/pay', () => {
      const createPayment = jest.fn();
      const service = () =>
        new ReservationPaymentService(
          prisma as never,
          {
            createPayment,
          } as never,
        );
      const dto = (expectedTotal: number) => ({
        expectedTotal,
        phoneNumber: '061234561',
        method: 'AIRTEL_MONEY' as const,
      });

      beforeEach(() => {
        createPayment.mockReset();
        createPayment.mockResolvedValue({ paymentId: 'pay-1' });
      });

      it('délègue au paiement existant avec la commande liée et l’opérateur choisi', async () => {
        const { r, order } = await accepted();
        expect(
          (await booking.getMine('c1', r.id, at(2))).allowedActions,
        ).toEqual(['pay', 'cancel']);
        await expect(
          service().pay(user(1), r.id, dto(order.total), 'provider', at(2)),
        ).resolves.toEqual({ paymentId: 'pay-1' });
        expect(createPayment).toHaveBeenCalledWith(
          {
            orderId: order.id,
            phoneNumber: '061234561',
            method: 'AIRTEL_MONEY',
          },
          'fb-c1',
          'provider',
        );
      });

      it('total affiché périmé : 409 avec le total courant, aucun appel au prestataire', async () => {
        const { r, order } = await accepted();
        await expect(
          service().pay(user(1), r.id, dto(order.total - 1), undefined, at(2)),
        ).rejects.toSatisfy(
          (e: unknown) => codeOf(e) === 'RESERVATION_TOTAL_CHANGED',
        );
        expect(createPayment).not.toHaveBeenCalled();
      });

      it('pas encore acceptée, échéance passée, ou réservation d’un autre : refusé sans appel au prestataire', async () => {
        await table('t2', 'Table 2');
        const pending = await book(2, 'p', {}, T0);
        await expect(
          service().pay(user(2), pending.id, dto(0), undefined, at(2)),
        ).rejects.toSatisfy(
          (e: unknown) => codeOf(e) === 'RESERVATION_PAYMENT_CLOSED',
        );
        const { r, order } = await accepted();
        await expect(
          service().pay(user(1), r.id, dto(order.total), undefined, at(16)),
        ).rejects.toSatisfy(
          (e: unknown) => codeOf(e) === 'RESERVATION_PAYMENT_CLOSED',
        );
        expect(
          (await booking.getMine('c1', r.id, at(16))).allowedActions,
        ).not.toContain('pay');
        await expect(
          service().pay(user(2), r.id, dto(order.total), undefined, at(2)),
        ).rejects.toThrow('Réservation introuvable.');
        expect(createPayment).not.toHaveBeenCalled();
      });
    });
  });

  describe('4B-2 — SUCCESS tardif sur une réservation close (J4, OD-06)', () => {
    const T0 = new Date('2026-10-20T07:00:00Z');
    const at = (min: number) => new Date(T0.getTime() + min * MIN);
    const TOTAL = 11_500;
    let payments: PaymentService;

    beforeAll(() => {
      payments = new PaymentService(
        prisma as never,
        new EventEmitter2(),
        { get: (_k: string, d?: unknown) => d } as never,
        { currentMode: 'PAWAPAY' } as never,
        new PaymentEventService(prisma as never),
        new OutboxService(prisma as never),
        new OrderTransitionService(),
      );
    });

    const accepted = async () => {
      const r = await book(1, 'a', {}, T0);
      await vendor.accept('o1', r.id, at(1));
      const order = await prisma.order.findUniqueOrThrow({
        where: { reservationId: r.id },
      });
      return { r, order };
    };

    const pendingPayment = (orderId: string, createdAt: Date) =>
      prisma.payment.create({
        data: {
          orderId,
          amount: TOTAL,
          currency: 'XAF',
          phoneNumber: '061234561',
          method: 'MTN_MOMO',
          status: 'PENDING',
          provider: 'PAWAPAY',
          providerTransactionId: `ptx-${orderId}-${createdAt.getTime()}`,
          metadata: {},
          createdAt,
        },
      });

    /** Le verdict du prestataire, tel que le webhook pawaPay l'applique. */
    const success = (paymentId: string) =>
      payments.applyCollectionProviderStatus({
        paymentId,
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: TOTAL,
          currency: 'XAF',
          providerTransactionId: `pawa-${paymentId}`,
          raw: { status: 'COMPLETED' },
        },
        source: 'WEBHOOK',
      });

    const refundDue = () => outboxOf('order.refund_due');

    /** Ce que fait le gestionnaire `order.refund_due` du worker. */
    const openRefund = (orderId: string) =>
      new RefundsService(prisma as never).openForCancelledOrder({
        orderId,
        reason: 'test',
        reasonCode: 'ORDER_CANCELLED',
      });

    it('expirée après la grâce, puis SUCCESS : paiement SUCCESS, remboursement intégral dû, réservation EXPIRED, commande ANNULER', async () => {
      const { r, order } = await accepted();
      const p = await pendingPayment(order.id, at(2));
      // Grâce : 17 min après la tentative (at(19)).
      expect(await lifecycle.expireOverdue(at(20))).toBe(1);
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: p.id } }))
          .status,
      ).toBe('CANCELLED');

      await expect(success(p.id)).resolves.toBe('MISMATCH');

      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: p.id } }))
          .status,
      ).toBe('SUCCESS');
      expect(
        (await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } }))
          .status,
      ).toBe('EXPIRED');
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
          .status,
      ).toBe('ANNULER');
      expect(await refundDue()).toEqual([
        expect.objectContaining({
          aggregateId: order.id,
          payload: expect.objectContaining({
            reasonCode: 'ORDER_CANCELLED',
            requestedBy: null,
          }),
        }),
      ]);
      const incident = await prisma.incident.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(incident.severity).toBe('CRITICAL');
      expect(incident.description).toContain('ouvert automatiquement');

      // Le gestionnaire ouvre le remboursement intégral, rattaché au paiement.
      await expect(openRefund(order.id)).resolves.toMatchObject({
        amount: TOTAL,
      });
      expect(
        await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } }),
      ).toMatchObject({ paymentId: p.id, amount: TOTAL, status: 'PENDING' });
    });

    it('webhook rejoué : DUPLICATE, une seule obligation, un seul incident', async () => {
      const { order } = await accepted();
      const p = await pendingPayment(order.id, at(2));
      await lifecycle.expireOverdue(at(20));
      await success(p.id);
      await expect(success(p.id)).resolves.toBe('DUPLICATE');
      expect(await refundDue()).toHaveLength(1);
      expect(
        await prisma.incident.count({ where: { orderId: order.id } }),
      ).toBe(1);
    });

    it('tentative créée après la clôture puis SUCCESS : commande non relancée, remboursement dû écrit avec l’encaissement', async () => {
      const { r, order } = await accepted();
      expect(await lifecycle.expireOverdue(at(17))).toBe(1);
      // Tentative lue payable juste avant l'expiration, insérée juste après.
      const p = await pendingPayment(order.id, at(17));

      await expect(success(p.id)).resolves.toBe('APPLIED');

      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: p.id } }))
          .status,
      ).toBe('SUCCESS');
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
          .status,
      ).toBe('ANNULER');
      expect(
        (await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } }))
          .status,
      ).toBe('EXPIRED');
      expect(await refundDue()).toHaveLength(1);
      expect(
        (
          await prisma.incident.findFirstOrThrow({
            where: { orderId: order.id },
          })
        ).description,
      ).toContain('ouvert automatiquement');
    });

    it('réservation annulée par le client avant tout paiement, puis SUCCESS tardif : même issue', async () => {
      const { order, r } = await accepted();
      await booking.cancel('c1', r.id, at(3));
      const p = await pendingPayment(order.id, at(3));
      await expect(success(p.id)).resolves.toBe('APPLIED');
      expect(await refundDue()).toHaveLength(1);
      expect(
        (await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } }))
          .status,
      ).toBe('CANCELLED_BY_CLIENT');
    });
  });

  describe('4B-2 — annulation d’une réservation payée (J5, OD-07, OD-08 E)', () => {
    /** Arrivée 20/10 12:00 locale = 11:00Z, soit T0 + 240 min. */
    const T0 = new Date('2026-10-20T07:00:00Z');
    const at = (min: number) => new Date(T0.getTime() + min * MIN);
    let payments: PaymentService;

    beforeAll(() => {
      payments = new PaymentService(
        prisma as never,
        new EventEmitter2(),
        { get: (_k: string, d?: unknown) => d } as never,
        { currentMode: 'PAWAPAY' } as never,
        new PaymentEventService(prisma as never),
        new OutboxService(prisma as never),
        new OrderTransitionService(),
      );
    });

    /** Demande, acceptation, paiement confirmé par le prestataire. */
    const confirmed = async (stockToday = false, key = 'a') => {
      if (stockToday) {
        await prisma.product.update({
          where: { id: 'p1' },
          data: {
            stockPolicy: 'DAILY_QUOTA',
            stockQuotidien: 10,
            stockRestant: 10,
          },
        });
      }
      const r = await book(1, key, {}, T0);
      await vendor.accept('o1', r.id, at(1));
      const order = await prisma.order.findUniqueOrThrow({
        where: { reservationId: r.id },
      });
      const p = await prisma.payment.create({
        data: {
          orderId: order.id,
          amount: order.total,
          currency: 'XAF',
          phoneNumber: '061234561',
          method: 'MTN_MOMO',
          status: 'PENDING',
          provider: 'PAWAPAY',
          providerTransactionId: `ptx-${order.id}`,
          metadata: {},
          createdAt: at(2),
        },
      });
      await payments.applyCollectionProviderStatus({
        paymentId: p.id,
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: order.total,
          currency: 'XAF',
          providerTransactionId: `pawa-${p.id}`,
          raw: { status: 'COMPLETED' },
        },
        source: 'WEBHOOK',
      });
      const row = await prisma.reservation.findUniqueOrThrow({
        where: { id: r.id },
      });
      expect(row.status).toBe('CONFIRMED');
      return { r, order, payment: p };
    };

    const reservationOf = (id: string) =>
      prisma.reservation.findUniqueOrThrow({ where: { id } });
    const orderOf = (id: string) =>
      prisma.order.findUniqueOrThrow({ where: { id } });
    const refundDue = () => outboxOf('order.refund_due');

    it('le client annule à temps : CANCELLED_BY_CLIENT, commande ANNULER (SYSTEM), remboursement intégral dû, restaurant prévenu', async () => {
      const { r, order, payment } = await confirmed();
      const view = await booking.getMine('c1', r.id, at(10));
      expect(view.allowedActions).toContain('cancel');
      expect(view.cancellationPolicy).toEqual({
        freeUntil: at(120),
        refundable: true,
        lateCancellation: false,
        noShowRefundable: false,
      });

      await booking.cancel('c1', r.id, at(10));

      expect(await reservationOf(r.id)).toMatchObject({
        status: 'CANCELLED_BY_CLIENT',
        lateCancellation: false,
      });
      expect((await orderOf(order.id)).status).toBe('ANNULER');
      expect(
        await prisma.orderHistory.findFirst({
          where: { orderId: order.id, toStatus: 'ANNULER' },
        }),
      ).toMatchObject({ fromStatus: 'PAYER', actionId: 'SYSTEM' });
      expect(await refundDue()).toEqual([
        expect.objectContaining({
          aggregateId: order.id,
          payload: expect.objectContaining({
            reasonCode: 'ORDER_CANCELLED',
            requestedBy: 'c1',
          }),
        }),
      ]);
      expect(
        (await refundDue())[0].payload as Record<string, unknown>,
      ).not.toHaveProperty('vendorFault');
      expect(
        (await outboxOf()).filter(
          (n) =>
            (n.payload as { notice: string }).notice === 'CANCELLED_BY_CLIENT',
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            audience: 'VENDOR',
            refundXaf: order.total,
          }),
        }),
      ]);
      // Le gestionnaire `order.refund_due` ouvre le remboursement intégral.
      await new RefundsService(prisma as never).openForCancelledOrder({
        orderId: order.id,
        reason: 'test',
      });
      expect(
        await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } }),
      ).toMatchObject({
        paymentId: payment.id,
        amount: order.total,
        status: 'PENDING',
      });
    });

    it('à 120 min de l’arrivée : encore à temps (T ≥ 120) ; à 119 min : tardive, remboursée quand même (V1)', async () => {
      const first = await confirmed();
      await booking.cancel('c1', first.r.id, at(120));
      expect((await reservationOf(first.r.id)).lateCancellation).toBe(false);

      // La table est libérée par l'annulation ; le panier, consommé, est
      // reconstitué pour une seconde réservation.
      await prisma.cart.deleteMany({ where: { userId: 'c1' } });
      await cart('c1', 'p1', 'var1');
      const second = await confirmed(false, 'b');
      await booking.cancel('c1', second.r.id, at(121));
      expect(await reservationOf(second.r.id)).toMatchObject({
        status: 'CANCELLED_BY_CLIENT',
        lateCancellation: true,
      });
      expect(
        await prisma.reservationEvent.findFirst({
          where: {
            reservationId: second.r.id,
            toStatus: 'CANCELLED_BY_CLIENT',
          },
        }),
      ).toMatchObject({ reason: 'LATE_CANCELLATION' });
      expect((await refundDue()).map((e) => e.aggregateId)).toEqual([
        first.order.id,
        second.order.id,
      ]);
    });

    it('après l’heure d’arrivée : plus d’annulation client (409), rien ne bouge', async () => {
      const { r, order } = await confirmed();
      expect(
        (await booking.getMine('c1', r.id, at(240))).allowedActions,
      ).not.toContain('cancel');
      await expect(booking.cancel('c1', r.id, at(240))).rejects.toSatisfy(
        (e) =>
          (e as { getResponse: () => { code: string } }).getResponse().code ===
          'RESERVATION_ACTION_UNAVAILABLE',
      );
      expect((await reservationOf(r.id)).status).toBe('CONFIRMED');
      expect((await orderOf(order.id)).status).toBe('PAYER');
      expect(await refundDue()).toHaveLength(0);
    });

    it('stock du jour rendu à l’annulation', async () => {
      const { r } = await confirmed(true);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: 'p1' } }))
          .stockRestant,
      ).toBe(8);
      await booking.cancel('c1', r.id, at(30));
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: 'p1' } }))
          .stockRestant,
      ).toBe(10);
    });

    it('le restaurant annule une réservation payée : CANCELLED_BY_VENDOR, remboursement faute vendeur, client prévenu du montant', async () => {
      const { r, order } = await confirmed();
      expect((await vendor.get('o1', r.id, at(30))).allowedActions).toContain(
        'cancel',
      );
      await vendor.cancel(
        'o1',
        r.id,
        { reason: 'CLOSED_UNEXPECTEDLY' },
        at(30),
      );

      expect((await reservationOf(r.id)).status).toBe('CANCELLED_BY_VENDOR');
      expect((await orderOf(order.id)).status).toBe('ANNULER');
      expect(
        await prisma.orderHistory.findFirst({
          where: { orderId: order.id, toStatus: 'ANNULER' },
        }),
      ).toMatchObject({ actionId: 'RESTAURATEUR' });
      expect(await refundDue()).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            vendorFault: true,
            reasonCode: 'VENDOR_REJECTED',
          }),
        }),
      ]);
      expect(
        (await outboxOf()).filter(
          (n) =>
            (n.payload as { notice: string }).notice === 'CANCELLED_BY_VENDOR',
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            audience: 'CLIENT',
            refundXaf: order.total,
          }),
        }),
      ]);
    });

    it('commande déjà remise (LIVRER) : l’annulation est refusée, rien n’est remboursé', async () => {
      const { r, order } = await confirmed();
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'LIVRER' },
      });
      await expect(booking.cancel('c1', r.id, at(30))).rejects.toSatisfy(
        (e) =>
          (e as { getResponse: () => { code: string } }).getResponse().code ===
          'RESERVATION_STATE_CONFLICT',
      );
      expect((await reservationOf(r.id)).status).toBe('CONFIRMED');
      expect(await refundDue()).toHaveLength(0);
    });

    it('annulations client et restaurant simultanées : une seule issue, un seul remboursement dû', async () => {
      const { r } = await confirmed();
      const results = await Promise.allSettled([
        booking.cancel('c1', r.id, at(30)),
        vendor.cancel('o1', r.id, { reason: 'CLOSED_UNEXPECTEDLY' }, at(30)),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(await refundDue()).toHaveLength(1);
    });

    describe('J6 — arrivée par code et absence (option D)', () => {
      const HOUR = 60 * MIN;
      /** Absence déclarée à l'arrivée + 15 min (fenêtre B2) : 11:15Z. */
      const noShowAt = at(255);
      const afterNoShow = (h: number, m = 0) =>
        new Date(noShowAt.getTime() + h * HOUR + m * MIN);

      /** La remise par code telle que `completePickup` l'écrit. */
      const handOver = (orderId: string) =>
        prisma.$transaction((tx) =>
          new OrderTransitionService().tryTransition(tx as never, {
            orderId,
            from: 'PRET',
            to: 'LIVRER',
            actor: 'RESTAURATEUR',
            actorUserId: 'o1',
            source: 'APP',
            proof: 'PICKUP_CODE',
          }),
        );
      const ready = (orderId: string) =>
        prisma.order.update({
          where: { id: orderId },
          data: { status: 'PRET' },
        });

      it('code saisi : commande LIVRER et réservation HONORED dans la même transaction', async () => {
        const { r, order } = await confirmed();
        await ready(order.id);
        await expect(handOver(order.id)).resolves.toEqual({ moved: true });
        expect((await orderOf(order.id)).status).toBe('LIVRER');
        expect(await reservationOf(r.id)).toMatchObject({
          status: 'HONORED',
          honoredAt: expect.any(Date),
        });
        expect(
          await prisma.reservationEvent.findFirst({
            where: { reservationId: r.id, toStatus: 'HONORED' },
          }),
        ).toMatchObject({ actorRole: 'RESTAURATEUR', reason: 'PICKUP_CODE' });
      });

      it('absence déclarée : la remise est refusée, rien ne bouge', async () => {
        const { r, order } = await confirmed();
        await ready(order.id);
        await vendor.markNoShow('o1', r.id, noShowAt);
        await expect(handOver(order.id)).rejects.toSatisfy(
          (e) =>
            (e as { getResponse: () => { code: string } }).getResponse()
              .code === 'RESERVATION_STATE_CONFLICT',
        );
        expect((await orderOf(order.id)).status).toBe('PRET');
        expect((await reservationOf(r.id)).status).toBe('NO_SHOW');
      });

      it('absence retirée à 5 h 59 : réservation de nouveau confirmée ; à 6 h 01 : retrait refusé', async () => {
        const first = await confirmed();
        await vendor.markNoShow('o1', first.r.id, noShowAt);
        await vendor.undoNoShow('o1', first.r.id, afterNoShow(5, 59));
        expect((await reservationOf(first.r.id)).status).toBe('CONFIRMED');

        await vendor.markNoShow('o1', first.r.id, afterNoShow(5, 59));
        await expect(
          vendor.undoNoShow('o1', first.r.id, afterNoShow(12, 0)),
        ).rejects.toBeDefined();
        expect((await reservationOf(first.r.id)).status).toBe('NO_SHOW');
      });

      it('avis au client : la précommande n’est pas remboursée ; politique affichée avant de payer', async () => {
        const { r } = await confirmed();
        expect(
          (await booking.getMine('c1', r.id, at(10))).cancellationPolicy,
        ).toMatchObject({ noShowRefundable: false });
        await vendor.markNoShow('o1', r.id, noShowAt);
        expect(
          (await outboxOf()).filter(
            (n) => (n.payload as { notice: string }).notice === 'NO_SHOW',
          ),
        ).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({ paidPreorder: true }),
          }),
        ]);
      });

      it('à 12 h : commande ANNULER sans remboursement, encaissement partagé 50/50, une seule clôture', async () => {
        const { r, order } = await confirmed();
        await vendor.markNoShow('o1', r.id, noShowAt);

        expect(await lifecycle.settleNoShows(afterNoShow(11, 59))).toBe(0);
        expect((await orderOf(order.id)).status).toBe('PAYER');

        const [a, b] = await Promise.all([
          lifecycle.settleNoShows(afterNoShow(12)),
          lifecycle.settleNoShows(afterNoShow(12)),
        ]);
        expect(a + b).toBe(1);
        expect((await orderOf(order.id)).status).toBe('ANNULER');
        expect((await reservationOf(r.id)).status).toBe('NO_SHOW');
        expect(
          await prisma.orderHistory.findFirst({
            where: { orderId: order.id, toStatus: 'ANNULER' },
          }),
        ).toMatchObject({ actionId: 'SYSTEM', source: 'CRON' });
        const half = Math.floor(order.total / 2);
        expect(
          await prisma.reservationNoShowSettlement.findUniqueOrThrow({
            where: { reservationId: r.id },
          }),
        ).toMatchObject({
          orderId: order.id,
          restaurantId: 'v1',
          totalXaf: order.total,
          vendorShareXaf: half,
          platformShareXaf: order.total - half,
          vendorShareBps: 5_000,
        });
        expect(await refundDue()).toHaveLength(0);
        expect(await prisma.refund.count()).toBe(0);
        // Rejouée plus tard : rien de plus.
        expect(await lifecycle.settleNoShows(afterNoShow(24))).toBe(0);
      });

      it('grand livre : écriture FORFEIT équilibrée, commande soldée, part du restaurant due', async () => {
        const { r, order } = await confirmed();
        await vendor.markNoShow('o1', r.id, noShowAt);
        await lifecycle.settleNoShows(afterNoShow(12));
        const s = await prisma.reservationNoShowSettlement.findUniqueOrThrow({
          where: { reservationId: r.id },
        });

        const ledger = new LedgerService(prisma as never);
        await new LedgerPosterService(prisma as never, ledger).catchUp();

        const tx = await prisma.ledgerTransaction.findFirstOrThrow({
          where: { sourceEventKey: `reservation_no_show:${s.id}:forfeited` },
          include: { entries: true },
        });
        expect(tx.kind).toBe('FORFEIT');
        expect(tx.entries.reduce((sum, e) => sum + e.amountXaf, 0)).toBe(0);
        const byAccount = Object.fromEntries(
          tx.entries.map((e) => [e.account, e.amountXaf]),
        );
        expect(byAccount).toEqual({
          'clearing:order': order.total,
          'revenue:forfeit': -s.platformShareXaf,
          vendor_payable: -s.vendorShareXaf,
        });
      });

      describe('annulation par le support (I-10)', () => {
        const audit = { record: jest.fn() };
        const admin = () =>
          new ReservationAdminService(
            prisma as never,
            new OutboxService(prisma as never),
            new ReservationOrderRelease(
              new OrderTransitionService(),
              new StockService(),
            ),
            audit as never,
          );
        beforeEach(() => audit.record.mockReset());
        const MOTIF = 'Restaurant fermé par la mairie ce jour';
        const adminNotices = async () =>
          (await outboxOf()).filter(
            (n) =>
              (n.payload as { notice: string }).notice === 'CANCELLED_BY_ADMIN',
          );

        it('réservation payée : CANCELLED_BY_VENDOR (acteur ADMIN, motif), commande ANNULER, remboursement intégral par la file admin, deux avis, audit', async () => {
          const { r, order } = await confirmed();
          await expect(
            admin().cancel('admin-1', r.id, MOTIF, at(30)),
          ).resolves.toEqual({
            id: r.id,
            status: 'CANCELLED_BY_VENDOR',
            refundXaf: order.total,
          });
          expect(await reservationOf(r.id)).toMatchObject({
            status: 'CANCELLED_BY_VENDOR',
            cancelReason: 'OTHER',
          });
          expect(
            await prisma.reservationEvent.findFirst({
              where: { reservationId: r.id, toStatus: 'CANCELLED_BY_VENDOR' },
            }),
          ).toMatchObject({
            actorRole: 'ADMIN',
            actorId: 'admin-1',
            reason: MOTIF,
          });
          expect(
            await prisma.orderHistory.findFirst({
              where: { orderId: order.id, toStatus: 'ANNULER' },
            }),
          ).toMatchObject({ actionId: 'ADMIN', source: 'ADMIN_APP' });
          const [due] = await refundDue();
          expect(due.payload).toMatchObject({
            reasonCode: 'ORDER_CANCELLED',
            requestedBy: 'admin-1',
          });
          expect(due.payload).not.toHaveProperty('vendorFault');
          expect(
            (await adminNotices()).map(
              (n) => (n.payload as { audience: string }).audience,
            ),
          ).toEqual(['CLIENT', 'VENDOR']);
          expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({
              action: 'ORDER_STATUS_FORCED',
              targetId: order.id,
              reason: MOTIF,
            }),
          );
        });

        it('demande non acceptée : annulée sans commande ni remboursement, sans audit de commande', async () => {
          const r = await book(1, 'a', {}, T0);
          await admin().cancel('admin-1', r.id, MOTIF, at(1));
          expect((await reservationOf(r.id)).status).toBe(
            'CANCELLED_BY_VENDOR',
          );
          expect(await refundDue()).toHaveLength(0);
          expect(audit.record).not.toHaveBeenCalled();
        });

        it('absence non close : annulable (remboursement intégral) ; absence close : 409, rien ne bouge', async () => {
          const first = await confirmed();
          await vendor.markNoShow('o1', first.r.id, noShowAt);
          await admin().cancel('admin-1', first.r.id, MOTIF, afterNoShow(7));
          expect((await orderOf(first.order.id)).status).toBe('ANNULER');
          expect(await refundDue()).toHaveLength(1);

          await prisma.cart.deleteMany({ where: { userId: 'c1' } });
          await cart('c1', 'p1', 'var1');
          const second = await confirmed(false, 'b');
          await vendor.markNoShow('o1', second.r.id, noShowAt);
          await lifecycle.settleNoShows(afterNoShow(12));
          await expect(
            admin().cancel('admin-1', second.r.id, MOTIF, afterNoShow(13)),
          ).rejects.toSatisfy(
            (e) =>
              (e as { getResponse: () => { code: string } }).getResponse()
                .code === 'RESERVATION_STATE_CONFLICT',
          );
          expect((await reservationOf(second.r.id)).status).toBe('NO_SHOW');
          expect(await refundDue()).toHaveLength(1);
        });

        it('réservation inconnue : 404', async () => {
          await expect(
            admin().cancel('admin-1', 'inconnue', MOTIF, at(1)),
          ).rejects.toThrow('Réservation introuvable.');
        });
      });
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
