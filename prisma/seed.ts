/**
 * Seed de développement — Lilia Food.
 *
 * Reconstitue une plateforme cohérente et minimale : réglages, quartiers de
 * Brazzaville, comptes des quatre rôles, et **un vendeur complet** avec ses
 * sections de menu, ses produits et ses variantes.
 *
 * Les libellés et les prix sont ceux du catalogue réel de septembre 2026 — un
 * seed inventé donne un environnement où tout marche, y compris ce qui ne
 * marche pas en vrai.
 *
 * **Un seul vendeur, délibérément.** Ajouter des vendeurs est mécanique (une
 * entrée dans `VENDEURS`) ; ce qui compte est que celui-ci couvre les cas qui
 * cassent : une section propre au commerçant (« Les Grillades ») à côté des
 * sections par défaut, des produits à variantes multiples, et un produit
 * **sans section** qui doit rester vendable et remonter dans « Autres ».
 *
 * ⚠️ **Destructif** : `TRUNCATE ... CASCADE` sur toutes les tables métier.
 * Ne jamais l'exécuter sur la base de production. Le script refuse de démarrer
 * si `DATABASE_URL` ressemble à la prod (voir `assertNotProduction`).
 *
 * ⚠️ **Comptes Firebase** : les utilisateurs créés ici portent un `firebaseUid`
 * déterministe (`seed-<role>`) qui n'existe PAS dans Firebase Auth. Ils servent
 * aux requêtes, aux tests et à l'inspection de la base ; pour se connecter
 * réellement, créer les comptes dans Firebase et remplacer les `firebaseUid`
 * correspondants (ou passer par l'invitation vendeur, qui fait les deux).
 *
 * Usage :
 *   DATABASE_URL="postgresql://…/ma_base_dev" npx prisma db seed
 */
import { PrismaPg } from '@prisma/adapter-pg';
import {
  DayOfWeek,
  OnboardingStatus,
  PrismaClient,
  ProductType,
  Role,
  VendorType,
} from '@prisma/client';

import {
  DEFAULT_CATEGORIES_BY_VENDOR_TYPE,
} from '../apps/lilia-app/src/modules/categories/category.includes';
import { slugifyCategoryName } from '../apps/lilia-app/src/modules/categories/category-slug';

const connectionString = process.env.DATABASE_URL;
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// ─── Garde-fou ──────────────────────────────────────────────────────────────

/**
 * Refuse de tourner sur une base qui ressemble à la production.
 *
 * Ce n'est pas de la paranoïa : le `.env` du dépôt a pointé la base de
 * production pendant des mois, et une note de projet affirmait le contraire.
 * Un seed destructif ne doit pas dépendre de la mémoire de celui qui le lance.
 */
function assertNotProduction() {
  if (!connectionString) {
    throw new Error('DATABASE_URL absent — rien à semer.');
  }
  const interdits = [/prod/i, /ep-frosty-resonance/i];
  const suspect = interdits.find((r) => r.test(connectionString));
  const risque = suspect ?? (process.env.NODE_ENV === 'production' ? 'NODE_ENV' : null);
  if (!risque) return;

  // Échappatoire volontairement pénible : une variable d'environnement qu'on ne
  // pose pas par réflexe. Elle existe pour la remise à zéro délibérée d'un
  // environnement de recette, jamais pour contourner l'avertissement à la
  // hâte — et elle est journalisée, pour que le geste laisse une trace.
  if (process.env.ALLOW_DESTRUCTIVE_SEED === '1') {
    console.warn(
      `⚠️  ALLOW_DESTRUCTIVE_SEED=1 — TRUNCATE forcé sur une base signalée comme ` +
        `sensible (${risque}). Si ce n'était pas voulu, interrompez maintenant.`,
    );
    return;
  }

  throw new Error(
    `Refus de semer : la base visée ressemble à la production (${risque}).\n` +
      'Ce script fait un TRUNCATE de toutes les tables métier.\n' +
      'Posez ALLOW_DESTRUCTIVE_SEED=1 si c’est réellement voulu.',
  );
}

// ─── Données ────────────────────────────────────────────────────────────────

/** Les 21 quartiers réellement servis (extraits de la production). */
const QUARTIERS = [
  'Bacongo', 'Centre-ville', 'Djiri', 'La Gare', 'Makélékélé',
  'Marché Poto-Poto', 'Marché Total', 'Massengo', 'Mfilou', 'Mikalou',
  'Moukondo', 'Moungali', 'Mpila', 'Ngamakosso', 'Nkombo', 'Ouenzé',
  'Plateau', 'Plateau des 15 ans', 'Poto-Poto', 'Talangaï', 'Texaco',
];

interface SeedProduit {
  nom: string;
  /** Section de menu. `null` = produit volontairement sans section. */
  section: string | null;
  prix: number;
  productType?: ProductType;
  description?: string;
  variantes?: { label: string; prix: number }[];
}

interface SeedVendeur {
  cle: string;
  nom: string;
  vendorType: VendorType;
  adresse: string;
  quartier: string;
  phone: string;
  description?: string;
  /** DRAFT = vendeur en cours d'onboarding, invisible du client. */
  onboarding: OnboardingStatus;
  isActive?: boolean;
  fixedDeliveryFee?: number;
  minimumOrderAmount?: number;
  /** Sections propres au vendeur, EN PLUS de celles par défaut de son type. */
  sectionsSupplementaires?: string[];
  produits: SeedProduit[];
}

const VENDEURS: SeedVendeur[] = [
  {
    cle: 'maman-lili',
    nom: 'Chez Maman Lili',
    vendorType: VendorType.RESTAURANT,
    adresse: 'Avenue de la Base, Bacongo',
    quartier: 'Bacongo',
    phone: '060000001',
    description: 'Grillades et plats du pays, préparés à la commande.',
    onboarding: OnboardingStatus.ACTIVATED,
    fixedDeliveryFee: 1000,
    // « Les Grillades » n'est pas une catégorie de plateforme : c'est le nom
    // que CE commerçant donne à sa section. C'est précisément ce que le modèle
    // par vendeur rend possible.
    sectionsSupplementaires: ['Les Grillades'],
    produits: [
      {
        nom: 'Cuisse de Poulet', section: 'Les Grillades', prix: 1000,
        variantes: [
          { label: 'Petite', prix: 1000 },
          { label: 'Moyenne', prix: 1300 },
          { label: 'Grande', prix: 1500 },
        ],
      },
      {
        nom: 'Côte de Porc braisées', section: 'Les Grillades', prix: 1000,
        variantes: [
          { label: 'Petite', prix: 1000 },
          { label: 'Moyenne', prix: 1300 },
          { label: 'Grande', prix: 1500 },
        ],
      },
      {
        nom: 'Brochettes d’ailes de poulet', section: 'Les Grillades', prix: 1000,
        variantes: [
          { label: 'Petite', prix: 1000 },
          { label: 'Standard', prix: 1300 },
          { label: 'Grande', prix: 1500 },
        ],
      },
      {
        nom: 'Banane grillée', section: 'Accompagnements', prix: 500,
        variantes: [{ label: 'Une Portion de 10 morceaux', prix: 500 }],
      },
      { nom: 'Manioc', section: 'Accompagnements', prix: 100 },
      {
        nom: 'Eau Minerale Vival', section: 'Boissons', prix: 500,
        productType: ProductType.BEVERAGE,
        variantes: [
          { label: 'Bouteille 40Cl', prix: 150 },
          { label: 'Bouteille 60Cl', prix: 250 },
          { label: 'Bouteille 1.5L', prix: 500 },
        ],
      },
      // Produit délibérément SANS section : le client doit le voir remonter
      // dans « Autres », et le catalogue doit rester utilisable.
      { nom: 'Suggestion du chef', section: null, prix: 2000 },
    ],
  },
];

// ─── Exécution ──────────────────────────────────────────────────────────────

async function truncateAll() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AdminAuditLog", "Incident", "OutboxEvent", "PaymentEvent",
      "restaurant_payouts", "Refund", "payments",
      "DeliveryReview", "DeliveryLocation", "Delivery",
      "LoyaltyTransaction", "PromoUsage", "PromoCode",
      "OrderItem", "OrderHistory", "Order",
      "CartItem", "Cart", "Favorite", "Review",
      "MenuProduct", "MenuImage", "MenuDuJour",
      "ProductImage", "ProductVariant", "Product", "Category",
      "VendorPhoto", "OperatingHours", "Specialty", "VendorProfile",
      "Banner", "QuartierZone", "DeliveryZone", "Restaurant",
      "Adresses", "Quartier", "FcmToken", "User", "PlatformSettings"
    RESTART IDENTITY CASCADE
  `);
}

/** Horaires 07:00–22:00 sept jours sur sept, ouverts. */
function horairesStandard() {
  return Object.values(DayOfWeek).map((dayOfWeek) => ({
    dayOfWeek,
    openTime: '07:00',
    closeTime: '22:00',
    isClosed: false,
  }));
}

/**
 * Sections d'un vendeur : celles par défaut de son `vendorType`, plus les
 * siennes. Le tout dédoublonné **par slug** — c'est l'unicité que porte la
 * base, et deux libellés qui n'en diffèrent que par la casse désignent la même
 * section.
 */
function sectionsDe(v: SeedVendeur): { nom: string; slug: string; displayOrder: number }[] {
  const noms = [
    ...DEFAULT_CATEGORIES_BY_VENDOR_TYPE[v.vendorType],
    ...(v.sectionsSupplementaires ?? []),
  ];
  const parSlug = new Map<string, string>();
  for (const nom of noms) {
    const slug = slugifyCategoryName(nom);
    if (!parSlug.has(slug)) parSlug.set(slug, nom);
  }
  return [...parSlug.entries()].map(([slug, nom], displayOrder) => ({
    nom,
    slug,
    displayOrder,
  }));
}

async function main() {
  assertNotProduction();

  console.log('→ Nettoyage…');
  await truncateAll();

  console.log('→ Réglages plateforme');
  await prisma.platformSettings.create({ data: { id: 'singleton' } });

  console.log(`→ ${QUARTIERS.length} quartiers`);
  await prisma.quartier.createMany({
    data: QUARTIERS.map((nom) => ({ nom, ville: 'Brazzaville' })),
  });

  console.log('→ Comptes admin / livreur / client');
  const admin = await prisma.user.create({
    data: {
      firebaseUid: 'seed-admin',
      email: 'admin@liliafood.com',
      nom: 'Administrateur Lilia',
      phone: '060000000',
      role: Role.ADMIN,
    },
  });
  await prisma.user.create({
    data: {
      firebaseUid: 'seed-livreur',
      email: 'livreur@liliafood.com',
      nom: 'Livreur de test',
      phone: '060000010',
      role: Role.LIVREUR,
      driverStatus: 'AVAILABLE',
    },
  });
  const client = await prisma.user.create({
    data: {
      firebaseUid: 'seed-client',
      email: 'client@liliafood.com',
      nom: 'Client de test',
      phone: '060000020',
      role: Role.CLIENT,
      referralCode: 'SEEDTEST',
      loyaltyPoints: 250,
    },
  });

  const bacongo = await prisma.quartier.findUniqueOrThrow({ where: { nom: 'Bacongo' } });
  await prisma.adresses.create({
    data: {
      rue: 'Rue Mbochis, portail bleu face à la pharmacie',
      ville: 'Brazzaville',
      country: 'CG',
      userId: client.id,
      quartierId: bacongo.id,
      isDefault: true,
      label: 'Maison',
      landmark: 'Portail bleu face à la pharmacie',
    },
  });

  console.log(`→ ${VENDEURS.length} vendeurs`);
  for (const v of VENDEURS) {
    const quartier = await prisma.quartier.findUniqueOrThrow({ where: { nom: v.quartier } });
    const owner = await prisma.user.create({
      data: {
        firebaseUid: `seed-vendeur-${v.cle}`,
        email: `${v.cle}@liliafood.com`,
        nom: `Propriétaire ${v.nom}`,
        phone: v.phone,
        role: Role.RESTAURATEUR,
      },
    });

    const activated = v.onboarding === OnboardingStatus.ACTIVATED;
    const vendeur = await prisma.restaurant.create({
      data: {
        nom: v.nom,
        description: v.description,
        adresse: v.adresse,
        phone: v.phone,
        ownerId: owner.id,
        quartierId: quartier.id,
        vendorType: v.vendorType,
        onboardingStatus: v.onboarding,
        activatedAt: activated ? new Date() : null,
        activatedById: activated ? admin.id : null,
        adminApproved: true,
        adminApprovedAt: new Date(),
        adminApprovedById: admin.id,
        isActive: v.isActive ?? true,
        // Un vendeur en configuration naît fermé : c'est le défaut sûr.
        isOpen: activated,
        fixedDeliveryFee: v.fixedDeliveryFee ?? 1000,
        minimumOrderAmount: v.minimumOrderAmount ?? 0,
        operatingHours: { create: horairesStandard() },
        categories: { create: sectionsDe(v) },
      },
      include: { categories: true },
    });

    const parSlug = new Map(vendeur.categories.map((c) => [c.slug, c.id]));

    for (const p of v.produits) {
      const categoryId = p.section ? (parSlug.get(slugifyCategoryName(p.section)) ?? null) : null;
      if (p.section && !categoryId) {
        throw new Error(`Section « ${p.section} » absente chez ${v.nom} — seed incohérent.`);
      }

      await prisma.product.create({
        data: {
          nom: p.nom,
          description: p.description,
          prixOriginal: p.prix,
          restaurantId: vendeur.id,
          categoryId,
          productType: p.productType ?? ProductType.FOOD,
          variants: {
            create: p.variantes?.length
              ? p.variantes
              : [{ label: 'Standard', prix: p.prix }],
          },
        },
      });
    }

    console.log(
      `   ${v.nom} — ${vendeur.categories.length} sections, ${v.produits.length} produits (${v.onboarding})`,
    );
  }

  // ─── Vérification : ce que voit réellement un client ──────────────────────
  const visibles = await prisma.restaurant.count({
    where: { onboardingStatus: 'ACTIVATED', adminApproved: true, isActive: true },
  });
  const produits = await prisma.product.count();
  const sections = await prisma.category.count();
  console.log(
    `\n✔ ${visibles} vendeurs visibles du client, ${sections} sections, ${produits} produits.`,
  );
  console.log(
    '  Comptes : admin@liliafood.com · client@liliafood.com · livreur@liliafood.com',
  );
  console.log(
    '  ⚠️ firebaseUid factices (`seed-*`) : créer les comptes Firebase pour se connecter.',
  );
}

main()
  .catch((e) => {
    console.error('\n✖ Seed interrompu :', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
