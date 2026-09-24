import { OnboardingStatus, Prisma } from '@prisma/client';

/**
 * Définition unique de « ce vendeur est visible d'un client ».
 *
 * Trois conditions **indépendantes**, chacune décidée par un acteur différent :
 *
 * | Condition | Question posée | Décidée par |
 * |---|---|---|
 * | `onboardingStatus = ACTIVATED` | sa boutique est-elle configurée et publiée ? | admin, à l'activation |
 * | `adminApproved` | ce commerce a-t-il sa place sur la marketplace ? | admin, à la validation |
 * | `isActive` | est-il suspendu ? | admin, à la sanction |
 *
 * Elles étaient jusqu'ici recopiées à la main sur quatorze requêtes. Une
 * condition oubliée sur une seule d'entre elles suffit à exposer un vendeur qui
 * ne devrait pas l'être — c'est exactement comme cela que `GET /vendor-photos`
 * rendait la galerie de vendeurs non validés. Une constante partagée rend la
 * règle vérifiable d'un seul endroit.
 *
 * ⚠️ Ne **jamais** l'employer sur les vues d'administration ni sur
 * `findMyRestaurant` : un vendeur doit voir sa propre boutique pendant qu'il la
 * configure, et un admin doit voir tout ce qu'il supervise.
 */
export const PUBLIC_VENDOR_WHERE = {
  onboardingStatus: OnboardingStatus.ACTIVATED,
  adminApproved: true,
  isActive: true,
} as const satisfies Prisma.RestaurantWhereInput;

/**
 * Même règle, exprimée sur une relation `restaurant` imbriquée (produits,
 * menus, photos).
 */
export const PUBLIC_VENDOR_RELATION_WHERE = {
  restaurant: PUBLIC_VENDOR_WHERE,
} as const satisfies Prisma.ProductWhereInput;

/**
 * Ordre d'affichage **unique** du catalogue public.
 *
 * `GET /restaurants` triait par `createdAt` et `GET /vendors` par
 * `[isOpen, createdAt]` : deux listes de la même entité, deux ordres, et rien
 * pour dire lequel était le bon. Les deux consomment désormais cette constante.
 *
 * Les quatre critères, dans cet ordre et pour ces raisons :
 *
 * 1. `isOpen desc` — un commerce fermé ne remonte pas devant un commerce
 *    ouvert, quelle que soit la mise en ordre voulue. Un client qui ne peut
 *    pas commander maintenant n'a que faire d'un vendeur bien classé ;
 * 2. `displayOrder asc` — la volonté de l'administrateur. Elle reste au-dessus
 *    de la mise en avant : `displayOrder` est une **position explicite**
 *    (« 1 = premier »), `isFeatured` une distinction éditoriale grossière.
 *    Qui a rangé un vendeur premier l'a déjà dit ; mettre un autre en vedette
 *    ne doit pas défaire ce classement — pour cela, on change `displayOrder` ;
 * 3. `isFeatured desc` — **c'est ici, et nulle part ailleurs, que la mise en
 *    avant agit sur la liste.** Elle a été livrée comme un *filtre*
 *    (`GET /vendors?isFeatured=true`) et la home du site l'a consommée telle
 *    quelle : mettre un vendeur en avant faisait disparaître tous les autres
 *    de la page d'accueil. Une mise en avant **classe**, elle n'exclut pas —
 *    c'est une clause `orderBy`, jamais une clause `where`. Comme le
 *    `displayOrder` par défaut (1000) est partagé par tous ceux que personne
 *    n'a rangés, elle départage précisément la masse du catalogue, où elle a
 *    un effet visible, sans écraser un rangement délibéré ;
 * 4. `createdAt desc` — départage stable, et comportement historique pour tous
 *    les vendeurs qui partagent le `displayOrder` par défaut sans vedette.
 *
 * ⚠️ Cette constante décide de l'**ordre**, jamais de la **visibilité** : elle
 * s'emploie dans `orderBy`, `PUBLIC_VENDOR_WHERE` dans `where`. Deux clauses
 * SQL distinctes — un vendeur `DRAFT` mis en avant et classé premier reste
 * invisible, structurellement et pas par convention.
 */
export const PUBLIC_VENDOR_ORDER_BY = [
  { isOpen: 'desc' },
  { displayOrder: 'asc' },
  { isFeatured: 'desc' },
  { createdAt: 'desc' },
] as const satisfies Prisma.RestaurantOrderByWithRelationInput[];

/**
 * Colonnes de `Restaurant` que les lectures **publiques** ont le droit de
 * servir. Liste blanche, jamais liste noire — voir plus bas pourquoi.
 *
 * ## Le défaut que cette constante supprime
 *
 * Les cinq lectures publiques de vendeur (`GET /vendors`, `/vendors/:id`,
 * `GET /restaurants`, `/restaurants/:id`, `/restaurants/popular`) passaient un
 * `include:` Prisma. Or `include` ne choisit que des **relations** : tous les
 * champs scalaires du modèle partent avec, sans qu'on ait à les nommer.
 *
 * Elles publiaient donc, sans authentification :
 *
 * | Champ | Ce que ça donne à un inconnu |
 * |---|---|
 * | `payoutPhoneNumber` | le numéro Mobile Money qui encaisse **tout** le chiffre d'affaires du vendeur |
 * | `payoutAccountName` | le nom du titulaire de ce compte |
 * | `payoutProvider` | son opérateur |
 * | `commissionPercent` | les conditions commerciales négociées, lisibles par ses concurrents |
 * | `email` | l'adresse personnelle du propriétaire |
 * | `ownerId` | un identifiant interne de compte |
 *
 * L'**écriture** de ces colonnes était pourtant soigneusement fermée :
 * `payoutPhoneNumber` et `payoutProvider` sont réservés à
 * `PATCH /admin/vendors/:id/payout-account` et volontairement absents
 * d'`UpdateRestaurantDto`, précisément parce qu'« un compte compromis
 * détournerait tous les reversements suivants ». La lecture, elle, n'a jamais
 * été fermée. Vérifié en production le 20/09/2026 : quatre numéros en clair sur
 * un simple `curl`.
 *
 * ## Pourquoi une liste blanche, et pas une liste d'exclusion
 *
 * Une liste noire (`omit: { payoutPhoneNumber: true, … }`) aurait corrigé le
 * symptôme du jour et reproduit le défaut au suivant : c'est l'ajout des
 * colonnes de reversement, en août 2026, qui a rendu publique une information
 * qui ne l'était pas la veille — **sans qu'une seule ligne des cinq requêtes ne
 * change**. Une liste blanche a la propriété inverse : une colonne ajoutée au
 * modèle n'est pas servie tant que personne ne l'a inscrite ici.
 *
 * `vendor-public-projection.spec.ts` rend ce choix exigible : il compare cette
 * liste et {@link WITHHELD_VENDOR_FIELDS} à `Prisma.RestaurantScalarFieldEnum`
 * et échoue tant qu'une colonne du schéma n'est pas classée d'un côté ou de
 * l'autre. Ajouter un champ au modèle casse donc la compilation des tests, et
 * c'est un humain qui tranche — pas un `include`.
 *
 * ⚠️ Réservée aux lectures **publiques**. Les vues d'administration
 * (`/admin/vendors`), la vue du propriétaire sur sa propre boutique
 * (`GET /restaurants/mine`) et les réponses de création/approbation continuent
 * de servir le modèle entier : ce sont leurs destinataires légitimes.
 */
export const PUBLIC_VENDOR_SELECT = {
  // ── Identité et localisation ────────────────────────────────────────────
  id: true,
  nom: true,
  description: true,
  adresse: true,
  // Le téléphone **de l'établissement**, pas celui du propriétaire : c'est le
  // numéro que le client appelle quand il cherche sa commande. Il est déjà sur
  // la devanture.
  phone: true,
  imageUrl: true,
  imagePublicId: true,
  latitude: true,
  longitude: true,
  quartierId: true,
  deliveryInstructions: true,
  vendorType: true,

  // ── État commandable ────────────────────────────────────────────────────
  isOpen: true,
  // Toujours `true` sur une réponse publique (cf. PUBLIC_VENDOR_WHERE), mais
  // servi quand même : les clients déployés désérialisent ces champs, et les
  // retirer casserait leur parsing pour un gain de confidentialité nul.
  isActive: true,
  adminApproved: true,
  onboardingStatus: true,
  // Classement : les clients les lisent pour le badge « en vedette » et pour
  // reproduire l'ordre du serveur lors d'une fusion de pages.
  displayOrder: true,
  isFeatured: true,

  // ── Ce qu'il faut pour composer un panier ───────────────────────────────
  deliveryPriceMode: true,
  fixedDeliveryFee: true,
  estimatedDeliveryTimeMin: true,
  estimatedDeliveryTimeMax: true,
  minimumOrderAmount: true,
  supportsDelivery: true,
  supportsPickup: true,
  acceptsPreorders: true,
  preorderLeadHours: true,
  maxOrdersPerDay: true,

  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RestaurantSelect;

/**
 * Colonnes de `Restaurant` **délibérément retenues** hors des lectures
 * publiques, avec la raison de chacune.
 *
 * Ce n'est pas une constante décorative : `vendor-public-projection.spec.ts`
 * exige que `PUBLIC_VENDOR_SELECT ∪ WITHHELD_VENDOR_FIELDS` couvre exactement
 * les colonnes du modèle. Elle existe pour qu'« on a oublié d'y penser » et
 * « on a décidé de ne pas le publier » cessent d'être indiscernables.
 */
export const WITHHELD_VENDOR_FIELDS = {
  /** Compte de reversement — un numéro qui encaisse tout le CA d'un commerce. */
  payoutPhoneNumber: 'compte de reversement',
  payoutProvider: 'compte de reversement',
  payoutAccountName: 'compte de reversement',
  payoutVerifiedAt: 'compte de reversement',
  payoutVerifiedById: 'compte de reversement',

  /** Conditions commerciales, négociées vendeur par vendeur. */
  commissionPercent: 'condition commerciale',

  /**
   * Part de la livraison offerte par le vendeur (F3-02). Le client n'en voit
   * que l'effet, calculé par le devis `GET /quartiers/delivery-fee` (prix
   * client, part offerte, seuil) — jamais le réglage brut.
   */
  deliverySubsidyMode: 'condition commerciale',
  deliverySubsidyXaf: 'condition commerciale',
  freeDeliveryThresholdXaf: 'condition commerciale',

  /** Identité du propriétaire, distincte du contact de l'établissement. */
  email: 'donnée personnelle du propriétaire',
  ownerId: 'identifiant interne de compte',

  /** Journal d'administration : qui a validé quoi, et quand. */
  adminApprovedAt: 'trace d’administration',
  adminApprovedById: 'trace d’administration',
  activatedAt: 'trace d’administration',
  activatedById: 'trace d’administration',

  /** Drapeau d'exploitation lu par le cron d'ouverture — sans sens pour un client. */
  manualOverride: 'drapeau d’exploitation',

  /**
   * Champ mort : conservé pour une réintroduction de l'alcool sans migration,
   * mais `ProductValidatorService` rejette `ALCOHOL` et rien ne le lit.
   */
  minAgeRequired: 'champ mort (alcool non commercialisé)',
} as const satisfies Partial<Record<keyof Prisma.RestaurantSelect, string>>;
