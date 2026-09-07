/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminAuditAction, Prisma, User, VendorType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PUBLIC_VENDOR_ORDER_BY,
  PUBLIC_VENDOR_WHERE,
} from '../../common/vendor-visibility';
import { PaginationService } from '../../common/pagination/pagination.service';
import { type ProductTimeFields } from '../products/product-availability';
import {
  MENU_PRODUCTS_LIMIT,
  vendorMenuInclude,
  withAvailableNow,
} from '../products/vendor-menu.include';
import { ratingOf } from '../restaurants/restaurant-ratings';
import { defaultCategoriesCreateInput } from '../categories/category.includes';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { FilterVendorsDto } from './dto/filter-vendors.dto';
import { UpdateVendorProfileDto } from './dto/update-vendor-profile.dto';
import { VendorApprovedEvent, VendorCreatedEvent } from './events/vendor-events';

const VENDOR_PUBLIC_INCLUDE = {
  vendorProfile: true,
  operatingHours: true,
  specialties: true,
  // Galerie photos vendeur (VendorPhoto), cover d'abord puis displayOrder.
  photos: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
} satisfies Prisma.RestaurantInclude;

/**
 * Détail vendeur = identité publique + **la** carte partagée.
 *
 * ⚠️ Le bloc catalogue ne se déclare plus ici. Il vient de
 * `vendorMenuInclude`, la seule définition de « que vend ce commerçant ? », que
 * `RestaurantQueryService.findOne` importe également —
 * `vendor-menu-parity.spec.ts` échoue si l'un des deux s'en écarte.
 *
 * Deux choses ont disparu au passage, volontairement :
 *
 * 1. **Le filtre de stock** (`OR: [{ stockRestant: null }, { gt: 0 }]`). Il
 *    faisait *disparaître* de l'application un plat que le site affichait
 *    « Rupture ». Un plat épuisé aujourd'hui existe quand même : le masquer
 *    laisse croire qu'il n'est pas au menu. Le refus de vente reste porté par
 *    le serveur (`unavailabilityReason`, au panier **et** au checkout) — c'est
 *    l'affichage qui change, pas la protection.
 * 2. **L'absence de `take` et d'`orderBy`.** Sans borne, un catalogue de 400
 *    références partait entier sur la 4G ; sans tri, l'ordre était celui du tas
 *    PostgreSQL, qui bouge à chaque écriture.
 *
 * ⚠️ `fields` reste un paramètre, jamais `this.prisma.product.fields` : cette
 * fonction vit hors de la classe, `this` y vaut `undefined`. Le lui faire lire
 * a déjà mis `GET /vendors/:id` en 500 en production.
 */
function vendorDetailInclude(fields: ProductTimeFields, now = new Date()) {
  return {
    ...VENDOR_PUBLIC_INCLUDE,
    ...vendorMenuInclude(fields, now),
  } satisfies Prisma.RestaurantInclude;
}

@Injectable()
export class VendorsService {
  private readonly logger = new Logger(VendorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pagination: PaginationService,
    private readonly eventEmitter: EventEmitter2,
    private readonly audit: AdminAuditService,
  ) {}

  async createVendor(dto: CreateVendorDto, adminUserId: string) {
    const owner = await this.prisma.user.findUnique({
      where: { id: dto.ownerId },
      include: { restaurant: { select: { id: true } } },
    });
    if (!owner) throw new NotFoundException('Propriétaire introuvable.');
    if (owner.restaurant) {
      throw new BadRequestException(
        'Ce compte possède déjà un vendeur. Un user = un vendeur.',
      );
    }

    // Tout nouveau vendeur non-RESTAURANT passe par une validation admin
    // (hygiène marketplace). Les RESTAURANTs créés via cet endpoint sont
    // auto-approuvés pour préserver le flux d'onboarding classique.
    const adminApproved = dto.vendorType === VendorType.RESTAURANT;

    const profileFields = this.extractProfileFields(dto);
    const hasProfile = Object.keys(profileFields).length > 0;

    const vendor = await this.prisma.$transaction(async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: {
          nom: dto.nom,
          adresse: dto.adresse,
          phone: dto.phone,
          latitude: dto.latitude,
          longitude: dto.longitude,
          imageUrl: dto.imageUrl,
          ownerId: dto.ownerId,
          deliveryPriceMode: dto.deliveryPriceMode,
          fixedDeliveryFee: dto.fixedDeliveryFee,
          minimumOrderAmount: dto.minimumOrderAmount,
          vendorType: dto.vendorType,
          adminApproved,
          adminApprovedAt: adminApproved ? new Date() : null,
          adminApprovedById: adminApproved ? adminUserId : null,
          acceptsPreorders: dto.acceptsPreorders ?? false,
          preorderLeadHours: dto.preorderLeadHours,
          maxOrdersPerDay: dto.maxOrdersPerDay,
          // Sections de menu par défaut, créées dans la MÊME transaction : un
          // vendeur ne naît jamais sans carte à remplir.
          categories: { create: defaultCategoriesCreateInput(dto.vendorType) },
          ...(hasProfile && {
            vendorProfile: { create: profileFields },
          }),
        },
        include: VENDOR_PUBLIC_INCLUDE,
      });
      return restaurant;
    });

    this.logger.log(
      `Vendor ${vendor.vendorType} créé : ${vendor.nom} (${vendor.id}) — adminApproved=${vendor.adminApproved}`,
    );
    this.eventEmitter.emit(
      'vendor.created',
      new VendorCreatedEvent(vendor, adminUserId),
    );
    return { data: vendor };
  }

  async findAll(dto: FilterVendorsDto) {
    const where: Prisma.RestaurantWhereInput = {
      // Frontière de sécurité du module : activé, approuvé, non suspendu.
      ...PUBLIC_VENDOR_WHERE,
      ...(dto.vendorType && { vendorType: dto.vendorType }),
      ...(dto.isOpen !== undefined && { isOpen: dto.isOpen }),
      // Filtre éditorial, appliqué APRÈS la frontière de visibilité (il
      // s'ajoute à `PUBLIC_VENDOR_WHERE`, il ne s'y substitue pas) : un vendeur
      // mis en avant mais non publié reste invisible.
      ...(dto.isFeatured !== undefined && { isFeatured: dto.isFeatured }),
    };

    const { page, limit } = dto;

    const [vendors, total] = await this.prisma.$transaction([
      this.prisma.restaurant.findMany({
        where,
        include: VENDOR_PUBLIC_INCLUDE,
        orderBy: [...PUBLIC_VENDOR_ORDER_BY],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.restaurant.count({ where }),
    ]);

    return {
      data: vendors,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * **Source canonique de la carte d'un vendeur** — la route que le site et
   * l'application consomment toutes deux depuis la phase 2.
   *
   * La réponse porte tout ce dont un client a besoin pour rendre un menu sans
   * recalculer une seule règle métier :
   *
   * - `products` triés, bornés à `MENU_PRODUCTS_LIMIT`, épuisés compris, chacun
   *   avec son `availableNow` (verdict horaire du serveur) ;
   * - `categories` actives, dans l'ordre du vendeur ;
   * - `menuDuJour` actifs ;
   * - `averageRating` / `totalReviews` — absents jusqu'ici, d'où une application
   *   qui n'affichait jamais d'étoiles ;
   * - `totalProducts` / `hasMoreProducts` — pour que le client sache **qu'il
   *   manque quelque chose**. Une carte tronquée en silence fait disparaître
   *   des sections entières, les clients masquant les sections vides.
   */
  async findOne(id: string) {
    const now = new Date();
    const vendor = await this.prisma.restaurant.findFirst({
      where: { id, ...PUBLIC_VENDOR_WHERE },
      include: vendorDetailInclude(this.prisma.product.fields, now),
    });
    if (!vendor) throw new NotFoundException(`Vendeur "${id}" introuvable.`);

    const { _count, products, ...rest } = vendor;

    return {
      data: {
        ...rest,
        products: withAvailableNow(products, now),
        ...(await ratingOf(this.prisma, id)),
        totalProducts: _count.products,
        hasMoreProducts: _count.products > MENU_PRODUCTS_LIMIT,
      },
    };
  }

  /**
   * Range un vendeur dans les listes publiques.
   *
   * Ne touche **aucun** des trois champs de visibilité : classer un vendeur ne
   * le publie pas, et un `DRAFT` classé premier reste invisible. Les doublons
   * sont acceptés — « ces deux-là devant, l'ordre entre eux m'est égal » est
   * une intention légitime, que le tri secondaire départage.
   */
  async setDisplayOrder(id: string, displayOrder: number, adminUserId: string) {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { id },
      select: { id: true, nom: true, displayOrder: true },
    });
    if (!vendor) throw new NotFoundException('Vendeur introuvable.');

    const updated = await this.prisma.restaurant.update({
      where: { id },
      data: { displayOrder },
      select: { id: true, nom: true, displayOrder: true, isFeatured: true },
    });

    await this.audit.record({
      actorId: adminUserId,
      action: AdminAuditAction.VENDOR_DISPLAY_ORDER_CHANGED,
      targetType: 'Restaurant',
      targetId: id,
      metadata: { from: vendor.displayOrder, to: displayOrder },
    });

    return {
      data: updated,
      message: `« ${updated.nom} » est désormais en position ${displayOrder}.`,
    };
  }

  /** Met un vendeur en avant, ou l'en retire. Indépendant de `displayOrder`. */
  async setFeatured(id: string, isFeatured: boolean, adminUserId: string) {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { id },
      select: { id: true, nom: true, isFeatured: true },
    });
    if (!vendor) throw new NotFoundException('Vendeur introuvable.');
    if (vendor.isFeatured === isFeatured) {
      throw new BadRequestException(
        isFeatured
          ? `« ${vendor.nom} » est déjà mis en avant.`
          : `« ${vendor.nom} » n'est pas mis en avant.`,
      );
    }

    const updated = await this.prisma.restaurant.update({
      where: { id },
      data: { isFeatured },
      select: { id: true, nom: true, displayOrder: true, isFeatured: true },
    });

    await this.audit.record({
      actorId: adminUserId,
      action: AdminAuditAction.VENDOR_FEATURED_TOGGLED,
      targetType: 'Restaurant',
      targetId: id,
      metadata: { isFeatured },
    });

    return {
      data: updated,
      message: isFeatured
        ? `« ${updated.nom} » est mis en avant.`
        : `« ${updated.nom} » n'est plus mis en avant.`,
    };
  }

  async approveVendor(id: string, adminUserId: string) {
    const vendor = await this.prisma.restaurant.findUnique({ where: { id } });
    if (!vendor) throw new NotFoundException('Vendeur introuvable.');
    if (vendor.adminApproved) {
      throw new BadRequestException('Ce vendeur est déjà approuvé.');
    }

    const updated = await this.prisma.restaurant.update({
      where: { id },
      data: {
        adminApproved: true,
        adminApprovedAt: new Date(),
        adminApprovedById: adminUserId,
      },
      include: VENDOR_PUBLIC_INCLUDE,
    });

    this.logger.log(`Admin ${adminUserId} a approuvé le vendeur ${vendor.nom} (${id})`);
    this.eventEmitter.emit(
      'vendor.approved',
      new VendorApprovedEvent(updated, adminUserId),
    );
    return { data: updated };
  }

  async updateVendorProfile(
    restaurantId: string,
    caller: User,
    dto: UpdateVendorProfileDto,
  ) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: { owner: { select: { firebaseUid: true } }, vendorProfile: true },
    });
    if (!restaurant) throw new NotFoundException('Vendeur introuvable.');

    // L'autorisation se fait sur le rôle de l'APPELANT (caller.role), pas sur
    // celui du propriétaire. Sinon un RESTAURATEUR pourrait modifier le profil
    // d'un vendeur dont le owner est ADMIN (IDOR).
    const isOwner = restaurant.owner.firebaseUid === caller.firebaseUid;
    const isAdmin = caller.role === 'ADMIN';
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException(
        "Vous ne pouvez modifier que le profil de votre propre vendeur.",
      );
    }

    const profile = await this.prisma.vendorProfile.upsert({
      where: { restaurantId },
      create: { restaurantId, ...this.extractProfileFields(dto) },
      update: this.extractProfileFields(dto),
    });
    return { data: profile };
  }

  private extractProfileFields(
    dto: CreateVendorDto | UpdateVendorProfileDto,
  ): Prisma.VendorProfileCreateWithoutRestaurantInput {
    const fields: Prisma.VendorProfileCreateWithoutRestaurantInput = {};
    if (dto.story !== undefined) fields.story = dto.story;
    if (dto.certifications !== undefined) fields.certifications = dto.certifications;
    if (dto.specialties !== undefined) fields.specialties = dto.specialties;
    if (dto.productionNote !== undefined) fields.productionNote = dto.productionNote;
    return fields;
  }
}
