/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, User, VendorType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { FilterVendorsDto } from './dto/filter-vendors.dto';
import { UpdateVendorProfileDto } from './dto/update-vendor-profile.dto';
import { VendorApprovedEvent, VendorCreatedEvent } from './events/vendor-events';

const VENDOR_PUBLIC_INCLUDE = {
  vendorProfile: true,
  operatingHours: true,
  specialties: true,
} satisfies Prisma.RestaurantInclude;

const VENDOR_DETAIL_INCLUDE = {
  ...VENDOR_PUBLIC_INCLUDE,
  products: {
    // Convention stock : null = illimité, 0 = épuisé, > 0 = quantité réelle.
    // `{ not: 0 }` exclut aussi les NULL (sémantique SQL : NULL != 0 →
    // UNKNOWN, pas TRUE). Sans cette branche OR, les produits HOME_COOK /
    // BAKERY créés sans stockQuotidien (= illimité) n'apparaissaient jamais
    // sur le détail vendeur (LIL-120).
    where: {
      OR: [{ stockRestant: null }, { stockRestant: { gt: 0 } }],
    },
    include: { category: true, variants: true },
  },
} satisfies Prisma.RestaurantInclude;

@Injectable()
export class VendorsService {
  private readonly logger = new Logger(VendorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pagination: PaginationService,
    private readonly eventEmitter: EventEmitter2,
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
      isActive: true,
      adminApproved: true, // SÉCURITÉ : jamais exposer les non approuvés
      ...(dto.vendorType && { vendorType: dto.vendorType }),
      ...(dto.isOpen !== undefined && { isOpen: dto.isOpen }),
    };

    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;

    const [vendors, total] = await this.prisma.$transaction([
      this.prisma.restaurant.findMany({
        where,
        include: VENDOR_PUBLIC_INCLUDE,
        orderBy: [{ isOpen: 'desc' }, { createdAt: 'desc' }],
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

  async findOne(id: string) {
    const vendor = await this.prisma.restaurant.findFirst({
      where: { id, isActive: true, adminApproved: true },
      include: VENDOR_DETAIL_INCLUDE,
    });
    if (!vendor) throw new NotFoundException(`Vendeur "${id}" introuvable.`);
    return { data: vendor };
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
