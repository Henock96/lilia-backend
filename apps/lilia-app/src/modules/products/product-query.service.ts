/* eslint-disable prettier/prettier */
import { Optional, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma, ProductType, VendorType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PUBLIC_VENDOR_ORDER_BY,
  PUBLIC_VENDOR_SELECT,
  PUBLIC_VENDOR_WHERE,
} from '../../common/vendor-visibility';
import { RESTAURANT_LIST_INCLUDE } from '../restaurants/restaurant.includes';
import { RestaurantAccessService } from '../restaurants/restaurant-access.service';
import { stockStatusWhere, type StockStatus } from './stock-status';
import {
  catalogProductWhere,
  isWithinAvailabilityWindow,
} from './product-availability';
import {
  MENU_IMAGES_ORDER_BY,
  MENU_PRODUCTS_ORDER_BY,
  MENU_VARIANTS_ORDER_BY,
  withAvailableNow,
} from './vendor-menu.include';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { modifiersEnabled } from '../modifiers/modifiers-switch';
import {
  PUBLIC_PRODUCT_MODIFIER_GROUPS_ARGS,
  withPublicModifiers,
} from '../modifiers/modifier-views';
import { variantStockVerdict, withVariantStock } from '../orders/stock-units';
import {
  escapeLike,
  foldSearchText,
  FUZZY_MIN_LENGTH,
  FUZZY_THRESHOLD,
} from './search-fold';

/**
 * Lectures du catalogue produits (extrait de ProductsService — LIL-143).
 * Regroupe les requêtes de consultation : catalogue, détail, populaires,
 * recherche et recommandations.
 */
/** Candidats examinés par `findAvailableNow` (colonnes légères seulement). */
export const AVAILABLE_NOW_CANDIDATE_CAP = 500;
/**
 * Commandes qui ne comptent pas pour `findPopular` : jamais payées, annulées,
 * ou échouées à la livraison.
 */
const POPULAR_IGNORED_STATUSES: OrderStatus[] = [
  OrderStatus.EN_ATTENTE,
  OrderStatus.ANNULER,
  OrderStatus.ECHEC_LIVRAISON,
];

/** Au plus 3 produits d'un même vendeur dans « Disponible maintenant ». */
export const AVAILABLE_NOW_PER_VENDOR = 3;

@Injectable()
export class ProductQueryService {
  constructor(
    private prisma: PrismaService,
    private readonly access: RestaurantAccessService,
    // F3-09 — interrupteur des options (catalogue) ; absent en test = éteint.
    @Optional() private readonly platformSettings?: PlatformSettingsService,
  ) {}

  /**
   * Récupère les produits du catalogue marketplace (route publique).
   *
   * ⚠️ Ce `where` recopiait la frontière marketplace à la main — `isActive` et
   * `adminApproved`, **sans** `onboardingStatus: ACTIVATED`. Le catalogue d'un
   * vendeur encore en `DRAFT` était donc servi publiquement par
   * `GET /products?restaurantId=…`, alors que le vendeur lui-même n'apparaissait
   * ni dans `GET /vendors` ni dans `GET /restaurants`, et que `GET /products/:id`,
   * `/popular`, `/search` et `/recommendations` — tous passés à
   * `PUBLIC_VENDOR_WHERE` — le masquaient correctement. Une seule des cinq
   * lectures publiques avait été oubliée, et c'était la principale.
   *
   * C'est exactement le risque que `PUBLIC_VENDOR_WHERE` existe pour supprimer :
   * la règle ne se recopie pas, elle s'importe.
   */
  async findAll(
    restaurantId?: string,
    categoryId?: string,
    page = 1,
    limit = 20,
    productType?: ProductType,
    vendorType?: VendorType,
  ) {
    const where: Prisma.ProductWhereInput = {
      restaurant: {
        ...PUBLIC_VENDOR_WHERE,
        ...(vendorType && { vendorType }),
      },
      ...(restaurantId && { restaurantId }),
      ...(categoryId && { categoryId }),
      ...(productType && { productType }),
      // Fixes M1 + M2 : produits retirés, marqués indisponibles ou hors de
      // leur fenêtre horaire ne sont plus servis au catalogue. Le filtre passe
      // par `AND` pour ne pas écraser un éventuel `OR` de la requête.
      AND: [catalogProductWhere(this.prisma.product.fields)],
    };

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          category: true,
          variants: { orderBy: [...MENU_VARIANTS_ORDER_BY] },
          restaurant: {
            select: {
              id: true,
              nom: true,
              vendorType: true,
            },
          },
          images: { orderBy: [...MENU_IMAGES_ORDER_BY] },
          modifierGroups: PUBLIC_PRODUCT_MODIFIER_GROUPS_ARGS,
        },
        // Le **même** tri que la carte (`vendorMenuInclude`), et ce n'est pas
        // une coquetterie : c'est par cette route que les clients complètent un
        // menu dépassant `MENU_PRODUCTS_LIMIT`. Un tri différent ferait
        // réapparaître en page 2 des produits déjà reçus en page 1, et en
        // sauterait d'autres — c'est-à-dire un menu faux, sans erreur visible.
        orderBy: [...MENU_PRODUCTS_ORDER_BY],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data: withPublicModifiers(
        withVariantStock(products),
        await modifiersEnabled(this.platformSettings),
      ),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Catalogue d'un vendeur, vue **back-office** — l'inverse exact de `findAll`.
   *
   * Les deux répondent à deux questions différentes, et c'est pour les avoir
   * confondues que le back-office était aveugle :
   *
   * | | `findAll` (public) | `findAllForOwner` (back-office) |
   * |---|---|---|
   * | question | « qu'y a-t-il à acheter ? » | « qu'ai-je à gérer ? » |
   * | vendeur suspendu / `DRAFT` | masqué | **visible** |
   * | produit `isAvailable = false` | masqué | **visible** |
   * | produit hors fenêtre horaire | masqué | **visible** |
   * | produit retiré (`deletedAt`) | masqué | masqué |
   *
   * Servir la vue publique au vendeur produisait des impasses : un produit
   * marqué indisponible disparaissait de l'écran d'où on le remet en vente, et
   * une viennoiserie « 06:00 → 11:00 » devenait immodifiable l'après-midi. Un
   * vendeur suspendu, lui, ne voyait plus rien du tout — au moment précis où il
   * a besoin de corriger sa boutique.
   *
   * C'est la symétrie déjà posée pour les sections de menu
   * (`CategoriesService.findAllForOwner` / `findPublicByRestaurant`).
   */
  async findAllForOwner(
    firebaseUid: string,
    restaurantId?: string,
    categoryId?: string,
    page = 1,
    limit = 20,
    stockStatus?: StockStatus,
  ) {
    // Même arbitre que les écritures : le vendeur reste chez lui, seul un ADMIN
    // peut désigner une autre boutique. Une seule règle de propriété pour lire
    // et pour écrire — deux implémentations divergeraient.
    const restaurant = await this.access.resolveTargetRestaurant(
      firebaseUid,
      restaurantId,
    );

    const where: Prisma.ProductWhereInput = {
      restaurantId: restaurant.id,
      // Un produit retiré du catalogue n'est plus gérable : il ne survit que
      // pour que les commandes passées restent lisibles.
      deletedAt: null,
      // Même exclusion que le catalogue public : le produit fantôme d'un menu
      // `PLAT_SPECIAL` est le corps d'un menu, pas un article. Le laisser
      // apparaître ici le rendrait modifiable indépendamment du menu qu'il sert.
      menus: { none: { menu: { type: 'PLAT_SPECIAL' } } },
      ...(categoryId && { categoryId }),
      // Le filtre de stock n'a de sens que sur cette vue : le catalogue public
      // ne montre déjà que ce qui est vendable, et le vendeur est le seul à
      // avoir besoin de retrouver ce qui ne l'est plus. Filtrer côté serveur
      // et non dans l'interface, sinon on ne filtrerait que la page reçue.
      ...(stockStatus ? stockStatusWhere(stockStatus) : {}),
    };

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          category: true,
          variants: { orderBy: [...MENU_VARIANTS_ORDER_BY] },
          restaurant: {
            select: {
              id: true,
              nom: true,
              vendorType: true,
            },
          },
          images: { orderBy: [...MENU_IMAGES_ORDER_BY] },
        },
        // Le back-office voit sa carte **dans l'ordre où le client la voit**.
        // Sans cela, l'écran qui porte les boutons « monter / descendre »
        // afficherait un autre ordre que celui qu'il prétend régler — et le
        // vendeur classerait à l'aveugle.
        orderBy: [...MENU_PRODUCTS_ORDER_BY],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data: products,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Récupère un produit par son ID
   */
  /**
   * Détail public d'un produit.
   *
   * Même frontière marketplace que `findAll` : un produit d'un vendeur
   * suspendu ou non encore validé ne doit pas rester consultable par lien
   * direct (partage `share_plus`, lien collé, autre consommateur de l'API).
   */
  async findOne(id: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        id,
        restaurant: PUBLIC_VENDOR_WHERE,
        // Un produit RETIRÉ n'existe plus pour le public (fix M2). En
        // revanche, un produit simplement indisponible ou hors fenêtre reste
        // consultable : le client doit pouvoir voir la fiche et l'horaire.
        deletedAt: null,
      },
      include: {
        category: true,
        variants: { orderBy: [...MENU_VARIANTS_ORDER_BY] },
        restaurant: {
          select: {
            id: true,
            nom: true,
            // Ajoutés pour la fiche produit du site client. Sans `isOpen`,
            // elle proposait d'ajouter au panier d'une boutique fermée et le
            // refus n'arrivait qu'au paiement ; sans `preorderLeadHours`, elle
            // ne pouvait pas annoncer le préavis d'un produit sur commande.
            //
            // Vue volontairement réduite : ce n'est pas un `Restaurant`
            // complet, et un client qui aurait besoin des horaires ou du type
            // de vendeur doit lire `GET /restaurants/:id`.
            isOpen: true,
            preorderLeadHours: true,
          },
        },
        images: { orderBy: [...MENU_IMAGES_ORDER_BY] },
        modifierGroups: PUBLIC_PRODUCT_MODIFIER_GROUPS_ARGS,
      },
    });

    if (!product) {
      throw new NotFoundException(`Produit avec l'ID "${id}" non trouvé.`);
    }
    const [withModifiers] = withPublicModifiers(
      withVariantStock([product]),
      await modifiersEnabled(this.platformSettings),
    );

    return {
      data: {
        ...withModifiers,
        /**
         * Le produit est-il dans sa fenêtre de vente **maintenant** ?
         *
         * Calculé ici, et pas par le client. La règle — bornes « HH:mm »
         * comparées dans le fuseau de Brazzaville, fenêtres à cheval sur
         * minuit — n'existe qu'à un seul endroit, `isWithinAvailabilityWindow`,
         * celui-là même qu'applique le checkout pour accepter ou refuser.
         *
         * La recopier côté navigateur aurait créé deux vérités qui divergent en
         * silence : c'est exactement ce qui s'était produit sur les montants,
         * où le client affichait 800 XAF de frais et le serveur en facturait
         * 1 500.
         *
         * ⚠️ Corollaire : cette valeur est **périssable**. Une réponse mise en
         * cache plus de quelques minutes annoncera « disponible » après la
         * fermeture de la fenêtre.
         */
        availableNow: isWithinAvailabilityWindow(product),
      },
    };
  }

  /**
   * Produits les plus commandés — **contrat historique** de « Plats
   * populaires », conservé pour les applications déjà installées (même forme,
   * `orderCount` compris). Les versions récentes lisent `available-now`.
   *
   * Corrigé a minima le 30/09/2026 : le `groupBy` prenait les `limit` produits
   * les plus commandés de **tout** l'historique (annulées comprises), **puis**
   * retirait les non-servables — la liste pouvait sortir presque vide. Le
   * filtre (frontière publique, catalogue, stock) s'applique désormais dans le
   * `groupBy`, avant la coupe, et seules les commandes réellement passées
   * comptent.
   *
   * ⚠️ Pas de filtre d'ouverture, volontairement : les anciennes versions
   * affichent le badge « Fermé » (P3-01), et vider la liste la nuit leur
   * retirerait la section entière. C'est la différence avec `available-now`.
   */
  async findPopular(limit = 10) {
    const popularProductIds = await this.prisma.orderItem.groupBy({
      by: ['productId'],
      where: {
        order: { status: { notIn: POPULAR_IGNORED_STATUSES } },
        product: {
          restaurant: PUBLIC_VENDOR_WHERE,
          OR: [{ stockRestant: null }, { stockRestant: { gt: 0 } }],
          AND: [catalogProductWhere(this.prisma.product.fields)],
        },
      },
      _count: { productId: true },
      orderBy: { _count: { productId: 'desc' } },
      take: limit,
    });

    if (popularProductIds.length === 0) {
      return { data: [] };
    }

    const productIds = popularProductIds.map(p => p.productId);
    const countMap = Object.fromEntries(
      popularProductIds.map(p => [p.productId, p._count.productId]),
    );

    // Même filtre qu'au-dessus : entre les deux lectures, un produit peut
    // avoir été retiré — il sort, il n'est pas servi.
    const products = await this.prisma.product.findMany({
      where: {
        id: { in: productIds },
        restaurant: PUBLIC_VENDOR_WHERE,
        AND: [catalogProductWhere(this.prisma.product.fields)],
      },
      include: {
        category: true,
        variants: { orderBy: [...MENU_VARIANTS_ORDER_BY] },
        restaurant: {
          select: { id: true, nom: true, imageUrl: true, isOpen: true },
        },
        images: { orderBy: [...MENU_IMAGES_ORDER_BY] },
      },
    });

    const byId = new Map(withVariantStock(products).map(p => [p.id, p]));
    const sorted = productIds
      .map(id => byId.get(id))
      .filter(p => p != null)
      .map(p => ({ ...p, orderCount: countMap[p.id] || 0 }));

    return { data: sorted };
  }

  /**
   * `GET /products/available-now` — ce qu'un client peut commander **maintenant**.
   *
   * Remplace « Plats populaires » à l'accueil, qui prenait les 10 produits les
   * plus commandés **puis** retirait ce qui n'était pas servable : à 01h18 le
   * 30/09/2026, les 10 venaient de vendeurs fermés. Ici, l'ordre est inverse et
   * il ne doit jamais l'être à nouveau :
   *
   * ```
   * vendeur public ∧ ouvert ∧ catalogue ∧ stock (pré-filtre SQL)
   *   → verdict de stock exact par format (variantStockVerdict)
   *   → classement → au plus 3 par vendeur → limit
   * ```
   *
   * - « ouvert » = colonne `isOpen`, écrite chaque minute par le cron à partir
   *   de `decideOpening` (et tout de suite à la pause) ; le checkout recalcule
   *   la règle et reste l'autorité (écart ≤ 1 min, refus avec son message).
   * - Un produit **sur commande** (`madeToOrder`) n'est pas disponible
   *   maintenant : il se précommande.
   * - Classement : commandes **livrées** (LIVRER) des 30 derniers jours. Le
   *   compteur reste interne : ni `orderCount` ni score dans la réponse.
   * - Deux requêtes légères en parallèle (candidats, signal) puis une lecture
   *   complète des seuls produits retenus (≤ 20) : deux allers-retours.
   */
  async findAvailableNow(
    { vendorType, limit = 10 }: { vendorType?: VendorType; limit?: number },
    now = new Date(),
  ) {
    const where: Prisma.ProductWhereInput = {
      restaurant: {
        ...PUBLIC_VENDOR_WHERE,
        isOpen: true,
        ...(vendorType && { vendorType }),
      },
      madeToOrder: false,
      // Pré-filtre : réduit les candidats, le verdict exact vient ensuite.
      OR: [{ stockRestant: null }, { stockRestant: { gt: 0 } }],
      AND: [catalogProductWhere(this.prisma.product.fields, now)],
    };

    // Candidats et signal partent ensemble : le `groupBy` porte le même filtre
    // (relation `product`), il n'a pas besoin des identifiants des candidats.
    // Un aller-retour Render ↔ Neon de moins (~70 ms).
    const [candidates, delivered] = await Promise.all([
      this.prisma.product.findMany({
        where,
        select: {
          id: true,
          restaurantId: true,
          stockRestant: true,
          variants: { select: { stockConsumption: true } },
        },
        orderBy: [
          ...PUBLIC_VENDOR_ORDER_BY.map((o) => ({ restaurant: o })),
          ...MENU_PRODUCTS_ORDER_BY,
        ],
        take: AVAILABLE_NOW_CANDIDATE_CAP,
      }),
      this.prisma.orderItem.groupBy({
        by: ['productId'],
        where: {
          product: where,
          order: {
            status: OrderStatus.LIVRER,
            createdAt: { gte: new Date(now.getTime() - 30 * 24 * 3600_000) },
          },
        },
        _count: { productId: true },
      }),
    ]);

    // Verdict exact : au moins un format achetable. Sans format, rien à
    // mettre au panier (le panier exige un `variantId`).
    const sellable = candidates.filter((p) =>
      p.variants.some(
        (v) =>
          variantStockVerdict(p.stockRestant, v.stockConsumption)
            .stockStatus !== 'OUT_OF_STOCK',
      ),
    );
    if (sellable.length === 0) {
      return { data: [], meta: { generatedAt: now.toISOString() } };
    }

    const signal = new Map(
      delivered.map((d) => [d.productId, d._count.productId]),
    );

    // Tri stable : signal décroissant, puis l'ordre d'affichage public
    // (vendeur puis carte), déjà celui de `candidates`.
    const ranked = sellable
      .map((p, index) => ({ p, index, score: signal.get(p.id) ?? 0 }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(({ p }) => p);

    const perVendor = new Map<string, number>();
    const pickedIds: string[] = [];
    for (const p of ranked) {
      const n = perVendor.get(p.restaurantId) ?? 0;
      if (n >= AVAILABLE_NOW_PER_VENDOR) continue;
      perVendor.set(p.restaurantId, n + 1);
      pickedIds.push(p.id);
      if (pickedIds.length === limit) break;
    }

    const rows = await this.prisma.product.findMany({
      where: { id: { in: pickedIds } },
      include: {
        category: true,
        variants: { orderBy: [...MENU_VARIANTS_ORDER_BY] },
        restaurant: {
          select: { id: true, nom: true, imageUrl: true, isOpen: true, vendorType: true },
        },
        images: { orderBy: [...MENU_IMAGES_ORDER_BY] },
        modifierGroups: PUBLIC_PRODUCT_MODIFIER_GROUPS_ARGS,
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = pickedIds.map((id) => byId.get(id)).filter((r) => r != null);

    return {
      data: withPublicModifiers(
        withVariantStock(ordered),
        await modifiersEnabled(this.platformSettings),
      ),
      meta: { generatedAt: now.toISOString() },
    };
  }

  /**
   * Recherche de produits et de vendeurs par texte — `GET /products/search`.
   *
   * Même vendeur, même produit que partout ailleurs dans le catalogue public :
   *
   * - **vendeurs** : `select` sur {@link PUBLIC_VENDOR_SELECT}, jamais
   *   `include`. Cette branche était restée en `include:` après la correction
   *   des cinq autres lectures publiques (20/09/2026) : le 03/10/2026, une
   *   recherche d'une seule lettre rendait sans jeton le numéro de reversement
   *   de sept vendeurs (`payoutPhoneNumber`), leur e-mail et leur `ownerId`.
   * - **ordre** : {@link PUBLIC_VENDOR_ORDER_BY} — ouverts d'abord. La coupe à
   *   `limit` arrive **après** le tri : sans `orderBy`, l'ordre était celui du
   *   tas PostgreSQL, et « poulet » rendait 20 plats dont 12 de boutiques
   *   fermées intercalés avec les commandables.
   * - **produits** : les verdicts serveur de la carte — fenêtre de vente
   *   (`availableNow`), stock **par format** (`stockStatus`), options. Les
   *   résultats sont rendus par les mêmes cartes que le menu ; sans ces
   *   champs, l'application recalculait la fenêtre avec l'heure du téléphone.
   *
   * Les plats de boutiques fermées restent dans la réponse, à leur place
   * (après les commandables) : les masquer laisserait croire qu'ils ne sont
   * pas au menu. Le refus de vente reste au panier et au checkout.
   */
  async search(query: string, limit = 20, now = new Date()) {
    const searchTerm = query.trim();
    if (!searchTerm) {
      return { restaurants: [], products: [] };
    }

    // Le texte n'est comparé qu'ici, replié des deux côtés (accents, casse,
    // œ, apostrophe typographique). La frontière marketplace, le catalogue,
    // l'ordre et la coupe restent portés par les requêtes Prisma ci-dessous,
    // inchangées : elles ne reçoivent que des identifiants candidats.
    const { productIds, vendorIds } = await this.searchCandidates(searchTerm);
    if (productIds.length === 0 && vendorIds.length === 0) {
      return { restaurants: [], products: [] };
    }

    const [restaurants, products, modifiersOn] = await Promise.all([
      this.prisma.restaurant.findMany({
        where: {
          ...PUBLIC_VENDOR_WHERE,
          id: { in: vendorIds },
        },
        select: { ...PUBLIC_VENDOR_SELECT, ...RESTAURANT_LIST_INCLUDE },
        orderBy: [...PUBLIC_VENDOR_ORDER_BY],
        take: limit,
      }),
      this.prisma.product.findMany({
        where: {
          id: { in: productIds },
          restaurant: PUBLIC_VENDOR_WHERE,
          AND: [catalogProductWhere(this.prisma.product.fields, now)],
        },
        include: {
          category: true,
          variants: { orderBy: [...MENU_VARIANTS_ORDER_BY] },
          restaurant: {
            select: { id: true, nom: true, imageUrl: true, isOpen: true },
          },
          images: { orderBy: [...MENU_IMAGES_ORDER_BY] },
          modifierGroups: PUBLIC_PRODUCT_MODIFIER_GROUPS_ARGS,
        },
        orderBy: [
          ...PUBLIC_VENDOR_ORDER_BY.map((o) => ({ restaurant: o })),
          ...MENU_PRODUCTS_ORDER_BY,
        ],
        take: limit,
      }),
      modifiersEnabled(this.platformSettings),
    ]);

    return {
      restaurants,
      products: withPublicModifiers(
        withVariantStock(withAvailableNow(products, now)),
        modifiersOn,
      ),
    };
  }

  /**
   * Identifiants des produits et vendeurs dont le texte correspond à la
   * saisie, en **un** aller-retour.
   *
   * 1. Correspondance exacte, repliée (`lilia_search_fold`) : « gateau »
   *    retrouve « Gâteaux », « d'ailes » retrouve « d’ailes ».
   * 2. Seulement si la première ne rend **rien**, et pour une saisie d'au moins
   *    {@link FUZZY_MIN_LENGTH} lettres : recherche approchée
   *    (`word_similarity` ≥ {@link FUZZY_THRESHOLD}) — « poulle » → poulet.
   *    Jamais mêlée à une correspondance exacte : elle n'ajoute pas de bruit à
   *    une recherche qui a déjà trouvé.
   *
   * Aucune frontière ici (vendeur publié, catalogue, stock) : elles sont
   * appliquées ensuite par les mêmes `where` que partout ailleurs. Un
   * identifiant candidat hors frontière ne sort donc jamais.
   */
  private async searchCandidates(
    searchTerm: string,
  ): Promise<{ productIds: string[]; vendorIds: string[] }> {
    const folded = foldSearchText(searchTerm);
    const pattern = `%${escapeLike(folded)}%`;
    const fuzzy = [...folded].length >= FUZZY_MIN_LENGTH;

    const rows = await this.prisma.$queryRaw<{ kind: 'p' | 'v'; id: string; exact: boolean }[]>`
      WITH p AS (
        SELECT p.id,
               lilia_search_fold(p.nom) LIKE ${pattern} ESCAPE '\'
            OR lilia_search_fold(p.description) LIKE ${pattern} ESCAPE '\'
            OR lilia_search_fold(c.nom) LIKE ${pattern} ESCAPE '\' AS exact,
               GREATEST(
                 word_similarity(${folded}, lilia_search_fold(p.nom)),
                 word_similarity(${folded}, lilia_search_fold(c.nom))
               ) AS sim
          FROM "Product" p
          LEFT JOIN "Category" c ON c.id = p."categoryId"
         WHERE p."deletedAt" IS NULL
      ), v AS (
        SELECT r.id,
               lilia_search_fold(r.nom) LIKE ${pattern} ESCAPE '\'
            OR EXISTS (SELECT 1 FROM "Specialty" s
                        WHERE s."restaurantId" = r.id
                          AND lilia_search_fold(s.name) LIKE ${pattern} ESCAPE '\') AS exact,
               word_similarity(${folded}, lilia_search_fold(r.nom)) AS sim
          FROM "Restaurant" r
      )
      SELECT 'p' AS kind, id, exact FROM p
       WHERE exact OR (${fuzzy} AND sim >= ${FUZZY_THRESHOLD})
      UNION ALL
      SELECT 'v' AS kind, id, exact FROM v
       WHERE exact OR (${fuzzy} AND sim >= ${FUZZY_THRESHOLD})
    `;

    const anyExact = rows.some((r) => r.exact);
    const kept = anyExact ? rows.filter((r) => r.exact) : rows;
    return {
      productIds: kept.filter((r) => r.kind === 'p').map((r) => r.id),
      vendorIds: kept.filter((r) => r.kind === 'v').map((r) => r.id),
    };
  }

  /**
   * Recommandations basées sur l'historique de commandes de l'utilisateur
   */
  async getRecommendations(firebaseUid: string, limit = 10) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) return { data: [] };

    // 1. Récupérer les catégories et restaurants des commandes précédentes
    const userOrderItems = await this.prisma.orderItem.findMany({
      where: { order: { userId: user.id } },
      select: {
        productId: true,
        product: { select: { categoryId: true, restaurantId: true } },
      },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });

    if (userOrderItems.length === 0) {
      // Utilisateur sans historique → retourner les plats populaires
      return this.findPopular(limit);
    }

    const categoryIds = [...new Set(
      userOrderItems.map(oi => oi.product.categoryId).filter(Boolean),
    )] as string[];
    const restaurantIds = [...new Set(
      userOrderItems.map(oi => oi.product.restaurantId),
    )];
    const excludeIds = [...new Set(
      userOrderItems.map(oi => oi.productId),
    )];

    // 2. Trouver des produits similaires pas encore commandés
    const recommendations = await this.prisma.product.findMany({
      where: {
        id: { notIn: excludeIds },
        restaurant: PUBLIC_VENDOR_WHERE,
        AND: [catalogProductWhere(this.prisma.product.fields)],
        OR: [
          ...(categoryIds.length > 0 ? [{ categoryId: { in: categoryIds } }] : []),
          { restaurantId: { in: restaurantIds } },
        ],
      },
      include: {
        category: true,
        variants: { orderBy: [...MENU_VARIANTS_ORDER_BY] },
        restaurant: {
          select: { id: true, nom: true, imageUrl: true, isOpen: true },
        },
        images: { orderBy: [...MENU_IMAGES_ORDER_BY] },
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    return { data: recommendations };
  }
}
