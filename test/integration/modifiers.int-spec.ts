import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient, Role } from '@prisma/client';

import { CartCommonService } from '../../apps/lilia-app/src/modules/cart/cart-common.service';
import { CartItemsService } from '../../apps/lilia-app/src/modules/cart/cart-items.service';
import { ModifiersService } from '../../apps/lilia-app/src/modules/modifiers/modifiers.service';
import { OrderCheckoutService } from '../../apps/lilia-app/src/modules/orders/order-checkout.service';
import { OrderValidatorService } from '../../apps/lilia-app/src/modules/orders/order-validator.service';
import { OrderCalculatorService } from '../../apps/lilia-app/src/modules/orders/order-calculator.service';
import { OrderReorderService } from '../../apps/lilia-app/src/modules/orders/order-reorder.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { PreorderValidatorService } from '../../apps/lilia-app/src/modules/vendors/preorder-validator.service';
import { RestaurantAccessService } from '../../apps/lilia-app/src/modules/restaurants/restaurant-access.service';
import { RefundComposerService } from '../../apps/lilia-app/src/modules/refunds/refund-composer.service';
import { computePayoutBreakdown } from '../../apps/lilia-app/src/modules/payments/money.util';
import { CATALOG_CHANGED } from '../../apps/lilia-app/src/modules/events/catalog-events';

/**
 * F3-09 — options & suppléments, sur PostgreSQL réel.
 *
 * Les garanties de cette fonctionnalité sont des garanties de BASE : unicité
 * de ligne de panier par signature, FK composites vendeur, CHECK sur les
 * montants, verrous partagés au checkout. Un mock de Prisma ne peut en prouver
 * aucune. Les services exercés sont ceux de production ; seules les
 * dépendances hors sujet (Redis, horaires, historique) sont remplacées.
 *
 * Carte de référence (celle de la fiche) :
 *
 *   Poulet braisé — 3 000
 *     Accompagnement (obligatoire, 1) : Alloco +500 / Frites / Riz
 *     Suppléments (0 à 2)             : Œuf +300 (×3 max) / Fromage +500
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('F3-09 — options & suppléments (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let cart: CartItemsService;
  let common: CartCommonService;
  let modifiers: ModifiersService;
  let checkout: OrderCheckoutService;
  let reorder: OrderReorderService;
  let composer: RefundComposerService;
  const events = new EventEmitter2();
  const emitted: string[] = [];
  const audited: unknown[] = [];
  /** Pause facultative DANS la transaction de checkout (après création). */
  let insideCheckout: () => Promise<void> = async () => {};

  const settings = {
    modifiersEnabled: true,
    modifiersManagementEnabled: true,
    serviceFeePercent: 15,
    restaurantCommissionPercent: 10,
    deliveryPricingMode: 'VENDOR_LEGACY',
    loyaltyMinRedemption: 100,
    loyaltyPointValueXaf: 50,
  };
  const settingsService = { getSettings: async () => settings };

  const CLIENT = { id: 'mo-client', fb: 'fb-mo-c' };
  const OTHER_CLIENT = { id: 'mo-client2', fb: 'fb-mo-c2' };
  const OWNER = { id: 'mo-owner', fb: 'fb-mo-o' };
  const OWNER_B = { id: 'mo-owner-b', fb: 'fb-mo-ob' };
  const ADMIN = { id: 'mo-admin', fb: 'fb-mo-a' };
  const VENDOR = 'mo-vendor';
  const VENDOR_B = 'mo-vendor-b';

  const ALLOCO = { optionId: 'opt-alloco', quantity: 1 };
  const RIZ = { optionId: 'opt-riz', quantity: 1 };
  const OEUF = (quantity = 1) => ({ optionId: 'opt-oeuf', quantity });
  const FROMAGE = { optionId: 'opt-fromage', quantity: 1 };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    events.onAny((event) => emitted.push(String(event)));

    common = new CartCommonService(prisma as never, settingsService as never);
    cart = new CartItemsService(
      prisma as never,
      common,
      settingsService as never,
    );
    modifiers = new ModifiersService(
      prisma as never,
      new RestaurantAccessService(prisma as never),
      { record: async (entry: unknown) => void audited.push(entry) } as never,
      events,
      settingsService as never,
    );
    const validator = new OrderValidatorService(
      prisma as never,
      {} as never,
      { decide: async () => ({ open: true }) } as never,
    );
    checkout = new OrderCheckoutService(
      prisma as never,
      events,
      validator,
      new OrderCalculatorService(),
      {} as never, // promo — aucun code dans ces tests
      new StockService(),
      { get: () => undefined } as never, // Redis désactivé
      settingsService as never,
      new PreorderValidatorService(prisma as never),
      {} as never, // quartiers — retrait au comptoir
      {} as never, // destination — retrait au comptoir
      {} as never, // tarification plateforme — mode historique
      { recordCreation: async () => insideCheckout() } as never,
      { announce: async () => undefined } as never, // StockSignalService (F3-10)
    );
    reorder = new OrderReorderService(
      prisma as never,
      settingsService as never,
      { addMenu: async () => undefined } as never, // CartService (F3-10)
    );
    composer = new RefundComposerService(prisma as never, {} as never, events);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    Object.assign(settings, {
      modifiersEnabled: true,
      modifiersManagementEnabled: true,
    });
    insideCheckout = async () => {};
    emitted.length = 0;
    audited.length = 0;
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "User", "Restaurant", "Product", "ModifierGroup",
                     "Cart", "Order"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        { id: CLIENT.id, firebaseUid: CLIENT.fb, email: 'mo-c@t.local' },
        {
          id: OTHER_CLIENT.id,
          firebaseUid: OTHER_CLIENT.fb,
          email: 'mo-c2@t.local',
        },
        {
          id: OWNER.id,
          firebaseUid: OWNER.fb,
          email: 'mo-o@t.local',
          role: 'RESTAURATEUR',
        },
        {
          id: OWNER_B.id,
          firebaseUid: OWNER_B.fb,
          email: 'mo-ob@t.local',
          role: 'RESTAURATEUR',
        },
        {
          id: ADMIN.id,
          firebaseUid: ADMIN.fb,
          email: 'mo-a@t.local',
          role: 'ADMIN',
        },
      ],
    });
    for (const [id, owner] of [
      [VENDOR, OWNER.id],
      [VENDOR_B, OWNER_B.id],
    ]) {
      await prisma.restaurant.create({
        data: {
          id,
          nom: id,
          adresse: 'Poto-Poto',
          phone: '060000070',
          ownerId: owner,
          adminApproved: true,
          isActive: true,
          onboardingStatus: 'ACTIVATED',
          commissionPercent: 10,
        },
      });
    }
    await prisma.product.create({
      data: {
        id: 'p-poulet',
        nom: 'Poulet braisé',
        prixOriginal: 3000,
        restaurantId: VENDOR,
        variants: { create: { id: 'v-poulet', label: 'Standard', prix: 3000 } },
      },
    });
    await prisma.product.create({
      data: {
        id: 'p-brochette',
        nom: 'Brochettes',
        prixOriginal: 2000,
        restaurantId: VENDOR,
        variants: {
          create: { id: 'v-brochette', label: 'Standard', prix: 2000 },
        },
      },
    });
    await prisma.product.create({
      data: {
        id: 'p-b',
        nom: 'Plat du vendeur B',
        prixOriginal: 1000,
        restaurantId: VENDOR_B,
        variants: { create: { id: 'v-b', prix: 1000 } },
      },
    });
    await prisma.modifierGroup.create({
      data: {
        id: 'g-acc',
        restaurantId: VENDOR,
        name: 'Accompagnement',
        minSelect: 1,
        maxSelect: 1,
        options: {
          create: [
            {
              id: 'opt-alloco',
              name: 'Alloco',
              priceDeltaXaf: 500,
              displayOrder: 0,
            },
            { id: 'opt-frites', name: 'Frites', displayOrder: 1 },
            { id: 'opt-riz', name: 'Riz', displayOrder: 2 },
          ],
        },
      },
    });
    await prisma.modifierGroup.create({
      data: {
        id: 'g-sup',
        restaurantId: VENDOR,
        name: 'Suppléments',
        minSelect: 0,
        maxSelect: 2,
        displayOrder: 1,
        options: {
          create: [
            { id: 'opt-oeuf', name: 'Œuf', priceDeltaXaf: 300, maxQuantity: 3 },
            {
              id: 'opt-fromage',
              name: 'Fromage',
              priceDeltaXaf: 500,
              displayOrder: 1,
            },
          ],
        },
      },
    });
    await prisma.modifierGroup.create({
      data: {
        id: 'g-b',
        restaurantId: VENDOR_B,
        name: 'Sauce B',
        options: { create: [{ id: 'opt-b', name: 'Sauce B' }] },
      },
    });
    await prisma.productModifierGroup.createMany({
      data: [
        {
          productId: 'p-poulet',
          groupId: 'g-acc',
          restaurantId: VENDOR,
          displayOrder: 0,
        },
        {
          productId: 'p-poulet',
          groupId: 'g-sup',
          restaurantId: VENDOR,
          displayOrder: 1,
        },
        {
          productId: 'p-brochette',
          groupId: 'g-sup',
          restaurantId: VENDOR,
          displayOrder: 0,
        },
        { productId: 'p-b', groupId: 'g-b', restaurantId: VENDOR_B },
      ],
    });
  });

  const addPoulet = (
    options: { optionId: string; quantity: number }[],
    quantite = 1,
    fb = CLIENT.fb,
  ) => cart.addItem(fb, { variantId: 'v-poulet', quantite, options });
  const lines = () =>
    prisma.cartItem.findMany({
      where: { cart: { userId: CLIENT.id } },
      include: { options: true },
      orderBy: { createdAt: 'asc' },
    });
  const placeOrder = () =>
    checkout.createOrderFromCart(
      CLIENT.fb,
      { paymentMethod: 'MTN_MOMO', isDelivery: false } as never,
      `key-${Math.random()}`,
    ) as Promise<{ data: { id: string } }>;
  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (err: { response?: { code?: string }; message?: string }) =>
        err.response?.code ?? err.message,
    );

  // ─── Schéma : ce que la base refuse d'elle-même ───────────────────────────

  describe('base de données', () => {
    it('FK composite : un groupe du vendeur B ne s’attache pas à un produit du vendeur A', async () => {
      await expect(
        prisma.productModifierGroup.create({
          data: { productId: 'p-poulet', groupId: 'g-b', restaurantId: VENDOR },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      await expect(
        prisma.productModifierGroup.create({
          data: {
            productId: 'p-poulet',
            groupId: 'g-b',
            restaurantId: VENDOR_B,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it.each([
      [
        `UPDATE "ModifierOption" SET "priceDeltaXaf" = -1 WHERE id = 'opt-oeuf'`,
        'ModifierOption_price_delta_chk',
      ],
      [
        `UPDATE "ModifierOption" SET "maxQuantity" = 11 WHERE id = 'opt-oeuf'`,
        'ModifierOption_max_quantity_chk',
      ],
      [
        `UPDATE "ModifierGroup" SET "minSelect" = 3, "maxSelect" = 2 WHERE id = 'g-sup'`,
        'ModifierGroup_select_bounds_chk',
      ],
      [
        `UPDATE "ModifierGroup" SET "maxSelect" = 0, "minSelect" = 0 WHERE id = 'g-sup'`,
        'ModifierGroup_select_bounds_chk',
      ],
      [
        `UPDATE "PlatformSettings" SET "modifiersManagementEnabled" = true, "modifiersEnabled" = false`,
        'PlatformSettings_modifiers_rollout_chk',
      ],
    ])('CHECK : %s', async (sql, constraint) => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "PlatformSettings" (id, "updatedAt") VALUES ('singleton', now()) ON CONFLICT DO NOTHING`,
      );
      await expect(prisma.$executeRawUnsafe(sql)).rejects.toThrow(constraint);
    });

    it('CHECK : une ligne de menu ne porte pas d’option, et la signature est bornée', async () => {
      await addPoulet([ALLOCO]);
      const [line] = await lines();
      await prisma.menuDuJour.create({
        data: {
          id: 'm1',
          nom: 'Menu',
          prix: 4000,
          restaurantId: VENDOR,
          dateDebut: new Date(Date.now() - 3600e3),
          dateFin: new Date(Date.now() + 3600e3),
        },
      });
      await expect(
        prisma.cartItem.update({
          where: { id: line.id },
          data: { menuId: 'm1' },
        }),
      ).rejects.toThrow(/CartItem_menu_without_options/);
      await expect(
        prisma.cartItem.update({
          where: { id: line.id },
          data: { optionsSignature: 'x'.repeat(1001) },
        }),
      ).rejects.toThrow(/CartItem_options_signature_len_chk/);
    });

    it('CHECK : optionsTotalXaf est positif et inclus dans prix', async () => {
      await addPoulet([ALLOCO]);
      await placeOrder();
      const item = await prisma.orderItem.findFirstOrThrow();
      await expect(
        prisma.orderItem.update({
          where: { id: item.id },
          data: { optionsTotalXaf: item.prix + 1 },
        }),
      ).rejects.toThrow(/OrderItem_options_total_chk/);
    });

    it('une option portée par un panier ne se supprime pas en SQL sans purger la ligne (RESTRICT)', async () => {
      await addPoulet([ALLOCO]);
      await expect(
        prisma.modifierOption.delete({ where: { id: 'opt-alloco' } }),
        // Le libellé dépend de la version de PostgreSQL (RESTRICT 23001 en
        // local, P2003 en CI) : seule la contrainte fait foi.
      ).rejects.toThrow(/CartItemOption_optionId_fkey/);
    });
  });

  // ─── Panier ────────────────────────────────────────────────────────────────

  describe('panier', () => {
    it('même produit + mêmes options → une ligne, quantités additionnées (ordre d’entrée indifférent)', async () => {
      await addPoulet([ALLOCO, OEUF(2)]);
      await addPoulet([OEUF(2), ALLOCO], 2);
      const all = await lines();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        quantite: 3,
        optionsSignature: 'opt-alloco:1,opt-oeuf:2',
      });
      expect(all[0].options).toHaveLength(2);
    });

    it('même produit + options différentes → deux lignes', async () => {
      await addPoulet([ALLOCO]);
      await addPoulet([RIZ]);
      await addPoulet([ALLOCO, OEUF(1)]);
      expect((await lines()).map((l) => l.optionsSignature).sort()).toEqual([
        'opt-alloco:1',
        'opt-alloco:1,opt-oeuf:1',
        'opt-riz:1',
      ]);
    });

    it('ligne ancienne sans option + ligne à options : deux lignes, et un ajout sans option rejoint l’ancienne', async () => {
      // Ligne écrite avant F3-09 : signature par défaut ''.
      const c = await prisma.cart.create({ data: { userId: CLIENT.id } });
      await prisma.cartItem.create({
        data: {
          cartId: c.id,
          productId: 'p-brochette',
          variantId: 'v-brochette',
          quantite: 1,
        },
      });
      await cart.addItem(CLIENT.fb, {
        variantId: 'v-brochette',
        quantite: 1,
        options: [OEUF(1)],
      });
      await cart.addItem(CLIENT.fb, { variantId: 'v-brochette', quantite: 2 });
      const all = await lines();
      expect(all.map((l) => [l.optionsSignature, l.quantite])).toEqual([
        ['', 3],
        ['opt-oeuf:1', 1],
      ]);
    });

    it('concurrence : 10 ajouts simultanés de la même sélection → 1 ligne, quantité 10', async () => {
      await prisma.cart.create({ data: { userId: CLIENT.id } });
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => addPoulet([ALLOCO, FROMAGE])),
      );
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      const all = await lines();
      expect(all).toHaveLength(1);
      expect(all[0].quantite).toBe(10);
      expect(all[0].options).toHaveLength(2);
    });

    it('concurrence : deux sélections différentes en parallèle → deux lignes exactes', async () => {
      await prisma.cart.create({ data: { userId: CLIENT.id } });
      await Promise.all([
        ...Array.from({ length: 5 }, () => addPoulet([ALLOCO])),
        ...Array.from({ length: 5 }, () => addPoulet([RIZ])),
      ]);
      expect(
        (await lines()).map((l) => [l.optionsSignature, l.quantite]).sort(),
      ).toEqual([
        ['opt-alloco:1', 5],
        ['opt-riz:1', 5],
      ]);
    });

    it.each([
      [
        'application ancienne (aucune option) sur groupe obligatoire',
        [] as { optionId: string; quantity: number }[],
        'MODIFIER_REQUIRED',
      ],
      [
        'même option citée deux fois',
        [ALLOCO, OEUF(1), OEUF(2)],
        'DUPLICATE_OPTION',
      ],
      [
        'option d’un autre vendeur',
        [ALLOCO, { optionId: 'opt-b', quantity: 1 }],
        'MODIFIER_FOREIGN',
      ],
      ['deux accompagnements', [ALLOCO, RIZ], 'MODIFIER_TOO_MANY'],
      ['œuf ×4 (max 3)', [ALLOCO, OEUF(4)], 'MODIFIER_INVALID_QUANTITY'],
    ])('refus à l’ajout : %s', async (_label, options, code) => {
      expect(await codeOf(addPoulet(options))).toBe(code);
      expect(await lines()).toHaveLength(0);
    });

    it('interrupteur éteint : une option envoyée est refusée ; sans option, le produit reste commandable', async () => {
      settings.modifiersEnabled = false;
      expect(await codeOf(addPoulet([ALLOCO]))).toBe('MODIFIERS_DISABLED');
      expect(await codeOf(addPoulet([]))).toBe('OK');
    });

    it('GET /cart : totaux serveur, options nommées', async () => {
      await addPoulet([ALLOCO, OEUF(1)], 2);
      await cart.addItem(CLIENT.fb, { variantId: 'v-brochette', quantite: 1 });
      const view = await common.getCart(CLIENT.fb);
      const poulet = view!.items.find((i) => i.productId === 'p-poulet')!;
      expect(poulet).toMatchObject({
        unitPriceXaf: 3800,
        optionsTotalXaf: 800,
        lineTotalXaf: 7600,
        issue: null,
        options: [
          {
            groupName: 'Accompagnement',
            name: 'Alloco',
            priceDeltaXaf: 500,
            quantity: 1,
          },
          {
            groupName: 'Suppléments',
            name: 'Œuf',
            priceDeltaXaf: 300,
            quantity: 1,
          },
        ],
      });
      expect(view!.subTotalXaf).toBe(7600 + 2000);
      expect(view!.hasIssues).toBe(false);
      // La réponse ne fuit pas le catalogue interne du produit.
      expect(JSON.stringify(view)).not.toMatch(/modifierGroups|deletedAt/);
    });

    it('un client ne modifie pas le panier d’un autre', async () => {
      await addPoulet([ALLOCO]);
      const [line] = await lines();
      await expect(
        cart.updateItemQuantity(OTHER_CLIENT.fb, line.id, { quantite: 5 }),
      ).rejects.toThrow(/pas dans votre panier/);
      await expect(cart.removeItem(OTHER_CLIENT.fb, line.id)).rejects.toThrow(
        /pas dans votre panier/,
      );
    });
  });

  // ─── Gestion vendeur / admin ──────────────────────────────────────────────

  describe('éditeur d’options — suppression, purge, isolation', () => {
    it('retirer une option purge la ligne de panier ENTIÈRE qui la porte (jamais « Poulet » seul)', async () => {
      await addPoulet([ALLOCO, OEUF(1)]);
      await addPoulet([RIZ]);
      const res = await modifiers.updateGroup(
        OWNER.fb,
        Role.RESTAURATEUR,
        'g-acc',
        {
          options: [
            { id: 'opt-frites', name: 'Frites', priceDeltaXaf: 0 },
            { id: 'opt-riz', name: 'Riz', priceDeltaXaf: 0 },
          ],
        },
      );
      expect(res.meta.purgedCartLines).toBe(1);
      const left = await lines();
      expect(left.map((l) => l.optionsSignature)).toEqual(['opt-riz:1']);
      expect(
        await prisma.cartItemOption.count({ where: { optionId: 'opt-oeuf' } }),
      ).toBe(0);
      // Jamais commandée : suppression définitive.
      expect(
        await prisma.modifierOption.findUnique({ where: { id: 'opt-alloco' } }),
      ).toBeNull();
    });

    it('détacher un groupe purge les lignes qui portent ses options, pas les autres', async () => {
      await addPoulet([ALLOCO, OEUF(1)]);
      await addPoulet([RIZ]);
      const res = await modifiers.setProductGroups(
        OWNER.fb,
        Role.RESTAURATEUR,
        'p-poulet',
        {
          groupIds: ['g-acc'],
        },
      );
      expect(res.meta.purgedCartLines).toBe(1);
      expect((await lines()).map((l) => l.optionsSignature)).toEqual([
        'opt-riz:1',
      ]);
    });

    it('une rupture ne purge rien : le checkout refusera, GET /cart l’annonce', async () => {
      await addPoulet([ALLOCO]);
      await modifiers.setOptionAvailability(
        OWNER.fb,
        Role.RESTAURATEUR,
        'opt-alloco',
        { isAvailable: false },
      );
      expect(await lines()).toHaveLength(1);
      const view = await common.getCart(CLIENT.fb);
      expect(view!.items[0].issue?.code).toBe('MODIFIER_UNAVAILABLE');
      expect(view!.hasIssues).toBe(true);
    });

    it('chaque écriture émet CATALOG_CHANGED', async () => {
      const g = await modifiers.createGroup(OWNER.fb, Role.RESTAURATEUR, {
        name: 'Sauce',
        minSelect: 0,
        maxSelect: 1,
        options: [{ name: 'Piment', priceDeltaXaf: 0 }],
      });
      await modifiers.updateGroup(OWNER.fb, Role.RESTAURATEUR, g.data.id, {
        name: 'Sauces',
      });
      await modifiers.setOptionAvailability(
        OWNER.fb,
        Role.RESTAURATEUR,
        g.data.options[0].id,
        { isAvailable: false },
      );
      await modifiers.setProductGroups(
        OWNER.fb,
        Role.RESTAURATEUR,
        'p-poulet',
        { groupIds: ['g-acc', 'g-sup', g.data.id] },
      );
      await modifiers.setProductGroups(
        OWNER.fb,
        Role.RESTAURATEUR,
        'p-poulet',
        { groupIds: ['g-acc', 'g-sup'] },
      );
      await modifiers.reorderGroups(OWNER.fb, Role.RESTAURATEUR, {
        groupIds: [g.data.id, 'g-acc', 'g-sup'],
      });
      await modifiers.removeGroup(OWNER.fb, Role.RESTAURATEUR, g.data.id);
      expect(emitted.filter((e) => e === CATALOG_CHANGED)).toHaveLength(7);
    });

    it('vendeur B ne touche pas au catalogue de A — 404 / 403, rien n’est écrit', async () => {
      expect(
        await codeOf(
          modifiers.updateGroup(OWNER_B.fb, Role.RESTAURATEUR, 'g-acc', {
            name: 'Piraté',
          }),
        ),
      ).toMatch(/introuvable/);
      expect(
        await codeOf(
          modifiers.removeGroup(OWNER_B.fb, Role.RESTAURATEUR, 'g-acc'),
        ),
      ).toMatch(/introuvable/);
      expect(
        await codeOf(
          modifiers.setOptionAvailability(
            OWNER_B.fb,
            Role.RESTAURATEUR,
            'opt-alloco',
            { isAvailable: false },
          ),
        ),
      ).toMatch(/introuvable/);
      // Attacher son groupe au produit de A, ou le groupe de A à son produit.
      expect(
        await codeOf(
          modifiers.setProductGroups(
            OWNER_B.fb,
            Role.RESTAURATEUR,
            'p-poulet',
            { groupIds: ['g-b'] },
          ),
        ),
      ).toMatch(/Produit introuvable/);
      expect(
        await codeOf(
          modifiers.setProductGroups(OWNER_B.fb, Role.RESTAURATEUR, 'p-b', {
            groupIds: ['g-acc'],
          }),
        ),
      ).toMatch(/n'appartiennent pas/);
      // `restaurantId` forgé par un non-admin.
      expect(
        await codeOf(
          modifiers.createGroup(OWNER_B.fb, Role.RESTAURATEUR, {
            restaurantId: VENDOR,
            name: 'X',
            minSelect: 0,
            maxSelect: 1,
            options: [{ name: 'Y', priceDeltaXaf: 0 }],
          }),
        ),
      ).toMatch(/Seul un administrateur/);
      // Un client ne crée rien.
      expect(
        await codeOf(
          modifiers.createGroup(CLIENT.fb, Role.CLIENT, {
            name: 'X',
            minSelect: 0,
            maxSelect: 1,
            options: [{ name: 'Y', priceDeltaXaf: 0 }],
          }),
        ),
      ).toMatch(/posséder un vendeur/);
      const acc = await prisma.modifierGroup.findUniqueOrThrow({
        where: { id: 'g-acc' },
      });
      expect(acc.name).toBe('Accompagnement');
      expect(
        (
          await prisma.modifierOption.findUniqueOrThrow({
            where: { id: 'opt-alloco' },
          })
        ).isAvailable,
      ).toBe(true);
    });

    it('éditeur fermé : le vendeur est refusé, l’ADMIN prépare pour lui et c’est audité', async () => {
      settings.modifiersManagementEnabled = false;
      expect(
        await codeOf(
          modifiers.createGroup(OWNER.fb, Role.RESTAURATEUR, {
            name: 'X',
            minSelect: 0,
            maxSelect: 1,
            options: [{ name: 'Y', priceDeltaXaf: 0 }],
          }),
        ),
      ).toBe('MODIFIERS_MANAGEMENT_DISABLED');
      await modifiers.createGroup(ADMIN.fb, Role.ADMIN, {
        restaurantId: VENDOR,
        name: 'X',
        minSelect: 0,
        maxSelect: 1,
        options: [{ name: 'Y', priceDeltaXaf: 0 }],
      });
      expect(audited).toEqual([
        expect.objectContaining({
          action: 'VENDOR_CATALOG_EDITED',
          targetId: VENDOR,
        }),
      ]);
    });

    it('un minimum impossible à satisfaire est refusé', async () => {
      expect(
        await codeOf(
          modifiers.createGroup(OWNER.fb, Role.RESTAURATEUR, {
            name: 'X',
            minSelect: 2,
            maxSelect: 2,
            options: [{ name: 'Y', priceDeltaXaf: 0 }],
          }),
        ),
      ).toMatch(/exige 2 choix/);
    });
  });

  // ─── Checkout ──────────────────────────────────────────────────────────────

  describe('checkout', () => {
    it('commande normale : prix complet figé, options recopiées, chaîne de l’argent cohérente', async () => {
      await addPoulet([ALLOCO, OEUF(1)], 2);
      const { data: order } = await placeOrder();
      const saved = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: {
          items: { include: { options: { orderBy: { position: 'asc' } } } },
        },
      });
      const [item] = saved.items;
      expect(item).toMatchObject({
        prix: 3800,
        snapshotPrice: 3800,
        optionsTotalXaf: 800,
        quantite: 2,
      });
      expect(
        item.options.map((o) => [
          o.groupName,
          o.optionName,
          o.priceDeltaXaf,
          o.quantity,
          o.optionId,
        ]),
      ).toEqual([
        ['Accompagnement', 'Alloco', 500, 1, 'opt-alloco'],
        ['Suppléments', 'Œuf', 300, 1, 'opt-oeuf'],
      ]);
      // options → OrderItem → subTotal
      expect(saved.subTotal).toBe(7600);
      expect(saved.subTotal).toBe(item.prix * item.quantite);
      // subTotal → frais de service, commission
      expect(saved.serviceFee).toBe(1140);
      expect(saved.commissionAmount).toBe(760);
      expect(saved.total).toBe(7600 + 1140);
      // subTotal → reversement (même calcul que RestaurantPayoutService)
      const payout = computePayoutBreakdown({
        subTotalXaf: saved.subTotal,
        commissionPercent: saved.commissionPercent!,
      });
      expect(payout).toMatchObject({
        grossAmount: 7600,
        commissionAmount: 760,
        payoutAmount: 6840,
      });
      expect(await lines()).toHaveLength(0);

      // → remboursement d'une unité : 3 800, pas 3 000.
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'LIVRER' },
      });
      await prisma.payment.create({
        data: {
          orderId: order.id,
          amount: saved.total,
          phoneNumber: '242060000099',
          status: 'SUCCESS',
          provider: 'PAWAPAY',
          method: 'MTN_MOMO',
        },
      });
      const quote = await composer.quote(order.id, {
        lines: [{ kind: 'ITEM', orderItemId: item.id, quantity: 1 }],
      });
      expect(quote.lines).toEqual([
        expect.objectContaining({
          amountXaf: 3800,
          label: expect.stringMatching(/Alloco, Œuf/),
        }),
      ]);
    });

    it('commande historique immuable : renommer, réévaluer, supprimer ne change rien', async () => {
      await addPoulet([ALLOCO, OEUF(2)]);
      const { data: order } = await placeOrder();
      const before = await prisma.orderItem.findMany({
        where: { orderId: order.id },
        include: { options: { orderBy: { position: 'asc' } } },
      });

      await modifiers.updateGroup(OWNER.fb, Role.RESTAURATEUR, 'g-sup', {
        name: 'Extras',
        options: [
          {
            id: 'opt-oeuf',
            name: 'Œuf bio',
            priceDeltaXaf: 900,
            maxQuantity: 3,
          },
          { id: 'opt-fromage', name: 'Fromage', priceDeltaXaf: 500 },
        ],
      });
      await modifiers.updateGroup(OWNER.fb, Role.RESTAURATEUR, 'g-acc', {
        name: 'Garniture',
        options: [{ id: 'opt-riz', name: 'Riz', priceDeltaXaf: 0 }],
      });
      await modifiers.removeGroup(OWNER.fb, Role.RESTAURATEUR, 'g-sup');
      await prisma.productVariant.update({
        where: { id: 'v-poulet' },
        data: { prix: 9999 },
      });

      const after = await prisma.orderItem.findMany({
        where: { orderId: order.id },
        include: { options: { orderBy: { position: 'asc' } } },
      });
      expect(
        after.map(({ options, ...i }) => ({
          ...i,
          options: options.map(({ optionId: _o, ...rest }) => rest),
        })),
      ).toEqual(
        before.map(({ options, ...i }) => ({
          ...i,
          options: options.map(({ optionId: _o, ...rest }) => rest),
        })),
      );
      // Déjà commandées : retirées logiquement, pas effacées.
      expect(
        await prisma.modifierOption.findUniqueOrThrow({
          where: { id: 'opt-alloco' },
        }),
      ).toMatchObject({ deletedAt: expect.any(Date) });
      expect(
        await prisma.modifierGroup.findUniqueOrThrow({
          where: { id: 'g-sup' },
        }),
      ).toMatchObject({ deletedAt: expect.any(Date) });
    });

    it('option mise en rupture entre l’ajout et le checkout → 409 MODIFIER_UNAVAILABLE, rien d’écrit', async () => {
      await addPoulet([ALLOCO]);
      await prisma.modifierOption.update({
        where: { id: 'opt-alloco' },
        data: { isAvailable: false },
      });
      expect(await codeOf(placeOrder())).toBe('MODIFIER_UNAVAILABLE');
      expect(await prisma.order.count()).toBe(0);
      expect(await lines()).toHaveLength(1);
    });

    it('option supprimée restée au panier (course avec la purge) → 409 nominatif', async () => {
      await addPoulet([ALLOCO]);
      await prisma.modifierOption.update({
        where: { id: 'opt-alloco' },
        data: { deletedAt: new Date() },
      });
      const err = await placeOrder().catch(
        (e: { response: { code: string; message: string } }) => e.response,
      );
      expect(err).toMatchObject({
        code: 'MODIFIER_UNAVAILABLE',
        message: expect.stringMatching(/Alloco.*n'est plus proposée/),
      });
      expect(await prisma.order.count()).toBe(0);
    });

    it('ancienne application : ligne composée avant qu’un groupe obligatoire existe → refusée au checkout', async () => {
      // La brochette n'a que des suppléments facultatifs : ajout sans option.
      await cart.addItem(CLIENT.fb, { variantId: 'v-brochette', quantite: 1 });
      // Le vendeur rend un accompagnement obligatoire ensuite.
      await prisma.productModifierGroup.create({
        data: {
          productId: 'p-brochette',
          groupId: 'g-acc',
          restaurantId: VENDOR,
        },
      });
      expect(await codeOf(placeOrder())).toBe('MODIFIER_REQUIRED');
      expect(await prisma.order.count()).toBe(0);
    });

    it('prix d’une option changé entre l’ajout et le checkout → la commande prend le prix de la base', async () => {
      await addPoulet([ALLOCO, OEUF(1)]);
      await prisma.modifierOption.update({
        where: { id: 'opt-oeuf' },
        data: { priceDeltaXaf: 400 },
      });
      const { data: order } = await placeOrder();
      const item = await prisma.orderItem.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(item).toMatchObject({ prix: 3900, optionsTotalXaf: 900 });
    });

    it('interrupteur éteint après l’ajout → la ligne à options est refusée', async () => {
      await addPoulet([ALLOCO]);
      settings.modifiersEnabled = false;
      expect(await codeOf(placeOrder())).toBe('MODIFIERS_DISABLED');
    });
  });

  // ─── Courses checkout / catalogue ─────────────────────────────────────────

  describe('concurrence checkout ↔ vendeur', () => {
    it('T2 (rupture) valide pendant que T1 (checkout) démarre : T1 attend, relit, refuse', async () => {
      await addPoulet([ALLOCO]);
      let released!: () => void;
      const gate = new Promise<void>((r) => (released = r));
      const t2 = prisma.$transaction(async (tx) => {
        await tx.modifierOption.update({
          where: { id: 'opt-alloco' },
          data: { isAvailable: false },
        });
        await gate; // verrou tenu
      });
      await sleep(50);
      const t1 = codeOf(placeOrder());
      await sleep(300);
      released();
      await t2;
      expect(await t1).toBe('MODIFIER_UNAVAILABLE');
      expect(await prisma.order.count()).toBe(0);
    });

    it('T1 (checkout) tient ses verrous : la rupture T2 attend la fin de la commande', async () => {
      await addPoulet([ALLOCO]);
      const timeline: string[] = [];
      let t2!: Promise<unknown>;
      insideCheckout = async () => {
        // Dans la transaction du checkout, options verrouillées en partage.
        t2 = modifiers
          .setOptionAvailability(OWNER.fb, Role.RESTAURATEUR, 'opt-alloco', {
            isAvailable: false,
          })
          .then(() => timeline.push('T2 rupture validée'));
        await sleep(300);
        timeline.push('T1 fin de transaction');
      };
      await placeOrder();
      timeline.push('T1 validé');
      await t2;
      expect(timeline).toEqual([
        'T1 fin de transaction',
        'T1 validé',
        'T2 rupture validée',
      ]);
      // La commande a été figée sur un état valide à l'instant du verrou.
      const item = await prisma.orderItem.findFirstOrThrow({
        include: { options: true },
      });
      expect(item.options.map((o) => o.optionName)).toEqual(['Alloco']);
    });

    it('T1 (checkout) ↔ T2 (suppression du groupe) : aucune interblocage, état final cohérent', async () => {
      await addPoulet([ALLOCO]);
      let t2!: Promise<unknown>;
      insideCheckout = async () => {
        t2 = modifiers.removeGroup(OWNER.fb, Role.RESTAURATEUR, 'g-acc');
        await sleep(200);
      };
      await placeOrder();
      await t2;
      // Commandé une fois ⇒ retrait logique ; la commande garde sa copie.
      expect(
        await prisma.modifierGroup.findUniqueOrThrow({
          where: { id: 'g-acc' },
        }),
      ).toMatchObject({ deletedAt: expect.any(Date) });
      expect(
        await prisma.orderItemOption.count({ where: { optionName: 'Alloco' } }),
      ).toBe(1);
      expect(await lines()).toHaveLength(0);
    });

    it('rafale : 8 checkouts/ruptures entrelacés — jamais une commande sur une option déjà en rupture', async () => {
      for (let round = 0; round < 8; round++) {
        await prisma.cartItem.deleteMany();
        await prisma.modifierOption.update({
          where: { id: 'opt-alloco' },
          data: { isAvailable: true },
        });
        await addPoulet([ALLOCO]);
        let markedAt = 0;
        const [outcome] = await Promise.all([
          codeOf(placeOrder()),
          (async () => {
            await sleep(round * 7);
            await prisma.modifierOption.update({
              where: { id: 'opt-alloco' },
              data: { isAvailable: false },
            });
            markedAt = Date.now();
          })(),
        ]);
        if (outcome === 'OK') {
          const last = await prisma.order.findFirstOrThrow({
            orderBy: { createdAt: 'desc' },
          });
          // Le COMMIT de la commande précède forcément la rupture (verrou).
          expect(last.createdAt.getTime()).toBeLessThanOrEqual(markedAt);
        } else {
          expect(['MODIFIER_UNAVAILABLE', 'MODIFIER_CHANGED']).toContain(
            outcome,
          );
        }
      }
    });
  });

  // ─── Recommander ───────────────────────────────────────────────────────────

  describe('recommander', () => {
    async function pastOrder() {
      await addPoulet([ALLOCO, OEUF(2)]);
      const { data } = await placeOrder();
      return data.id as string;
    }

    it('toutes les options valides : la ligne revient avec la même sélection', async () => {
      const orderId = await pastOrder();
      const res = await reorder.reorderFromPreviousOrder(orderId, CLIENT.fb);
      expect(res.summary.totalAdded).toBe(1);
      expect((await lines()).map((l) => l.optionsSignature)).toEqual([
        'opt-alloco:1,opt-oeuf:2',
      ]);
    });

    it('une option n’est plus disponible : la ligne est IGNORÉE et signalée, jamais recréée sans elle', async () => {
      const orderId = await pastOrder();
      await prisma.modifierOption.update({
        where: { id: 'opt-alloco' },
        data: { isAvailable: false },
      });
      const res = await reorder.reorderFromPreviousOrder(orderId, CLIENT.fb);
      expect(res.summary).toMatchObject({ totalAdded: 0, totalUnavailable: 1 });
      expect(res.details.unavailable[0]).toMatchObject({
        productName: 'Poulet braisé',
        reason: expect.stringMatching(/Alloco/),
      });
      expect(await lines()).toHaveLength(0);
    });

    it('option supprimée pour de bon (lien perdu) : ignorée et signalée', async () => {
      const orderId = await pastOrder();
      await prisma.orderItemOption.updateMany({
        where: { optionName: 'Œuf' },
        data: { optionId: null },
      });
      const res = await reorder.reorderFromPreviousOrder(orderId, CLIENT.fb);
      expect(res.details.unavailable[0].reason).toMatch(
        /« Œuf » n'est plus proposée/,
      );
      expect(await lines()).toHaveLength(0);
    });
  });
});
