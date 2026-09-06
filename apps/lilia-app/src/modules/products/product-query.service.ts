/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductType, VendorType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';
import { RestaurantAccessService } from '../restaurants/restaurant-access.service';
import { stockStatusWhere, type StockStatus } from './stock-status';
import {
  catalogProductWhere,
  isWithinAvailabilityWindow,
} from './product-availability';

/**
 * Lectures du catalogue produits (extrait de ProductsService — LIL-143).
 * Regroupe les requêtes de consultation : catalogue, détail, populaires,
 * recherche et recommandations.
 */
@Injectable()
export class ProductQueryService {
  constructor(
    private prisma: PrismaService,
    private readonly access: RestaurantAccessService,
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
          variants: true,
          restaurant: {
            select: {
              id: true,
              nom: true,
              vendorType: true,
            },
          },
          images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
        },
        orderBy: { createdAt: 'desc' },
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
          variants: true,
          restaurant: {
            select: {
              id: true,
              nom: true,
              vendorType: true,
            },
          },
          images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
        },
        orderBy: { createdAt: 'desc' },
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
        variants: true,
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
        images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
      },
    });

    if (!product) {
      throw new NotFoundException(`Produit avec l'ID "${id}" non trouvé.`);
    }

    return {
      data: {
        ...product,
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
   * Récupère les produits les plus commandés (plats populaires)
   */
  async findPopular(limit = 10) {
    // 1. Agréger le nombre de commandes par produit
    const popularProductIds = await this.prisma.orderItem.groupBy({
      by: ['productId'],
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

    // 2. Récupérer les détails complets des produits
    const products = await this.prisma.product.findMany({
      where: {
        id: { in: productIds },
        restaurant: PUBLIC_VENDOR_WHERE,
        AND: [catalogProductWhere(this.prisma.product.fields)],
      },
      include: {
        category: true,
        variants: true,
        restaurant: {
          select: { id: true, nom: true, imageUrl: true, isOpen: true },
        },
        images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
      },
    });

    // 3. Trier par nombre de commandes et attacher le compteur
    const sorted = productIds
      .map(id => products.find(p => p.id === id))
      .filter(Boolean)
      .map(p => ({ ...p, orderCount: countMap[p.id] || 0 }));

    return { data: sorted };
  }

  /**
   * Recherche de produits et restaurants par texte
   */
  async search(query: string, limit = 20) {
    const searchTerm = query.trim();
    if (!searchTerm) {
      return { restaurants: [], products: [] };
    }

    const [restaurants, products] = await Promise.all([
      this.prisma.restaurant.findMany({
        // Fix SEC-01 : cette branche ne contrôlait que `isActive`, alors que la
        // branche `products` juste en dessous applique PUBLIC_VENDOR_WHERE. Un
        // vendeur en DRAFT ou non approuvé était donc énumérable par la
        // recherche publique — constaté en production sur « Le First Restaurant
        // Brazzaville », absent de GET /restaurants mais rendu par /search.
        where: {
          ...PUBLIC_VENDOR_WHERE,
          OR: [
            { nom: { contains: searchTerm, mode: 'insensitive' } },
            { specialties: { some: { name: { contains: searchTerm, mode: 'insensitive' } } } },
          ],
        },
        include: {
          specialties: true,
          operatingHours: true,
          photos: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
        },
        take: limit,
      }),
      this.prisma.product.findMany({
        where: {
          OR: [
            { nom: { contains: searchTerm, mode: 'insensitive' } },
            { description: { contains: searchTerm, mode: 'insensitive' } },
            { category: { nom: { contains: searchTerm, mode: 'insensitive' } } },
          ],
          restaurant: PUBLIC_VENDOR_WHERE,
          AND: [catalogProductWhere(this.prisma.product.fields)],
        },
        include: {
          category: true,
          variants: true,
          restaurant: {
            select: { id: true, nom: true, imageUrl: true, isOpen: true },
          },
          images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
        },
        take: limit,
      }),
    ]);

    return { restaurants, products };
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
        variants: true,
        restaurant: {
          select: { id: true, nom: true, imageUrl: true, isOpen: true },
        },
        images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    return { data: recommendations };
  }
}
