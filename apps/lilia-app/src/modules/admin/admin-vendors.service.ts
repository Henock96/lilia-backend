import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { VendorsService } from '../vendors/vendors.service';
import { AdminVendorFilterDto } from './dto/admin-vendor-filter.dto';

/**
 * Supervision marketplace côté admin (LIL-134) : liste/filtre vendeurs,
 * validation (delègue à VendorsService pour event + audit), suspension /
 * réactivation. Extrait de `AdminService` — API publique inchangée.
 */
@Injectable()
export class AdminVendorsService {
  private readonly logger = new Logger(AdminVendorsService.name);

  constructor(
    private prisma: PrismaService,
    private readonly vendorsService: VendorsService,
  ) {}

  async getAllVendors(dto: AdminVendorFilterDto) {
    const where: Prisma.RestaurantWhereInput = {
      ...(dto.vendorType && { vendorType: dto.vendorType }),
      ...(dto.adminApproved !== undefined && { adminApproved: dto.adminApproved }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    };

    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;

    const [vendors, total] = await Promise.all([
      this.prisma.restaurant.findMany({
        where,
        include: {
          owner: { select: { id: true, email: true, nom: true, phone: true } },
          vendorProfile: true,
          _count: { select: { products: true, orders: true } },
        },
        orderBy: [{ adminApproved: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.restaurant.count({ where }),
    ]);

    return {
      data: vendors,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Vendeurs en attente de validation (adminApproved=false).
   * Raccourci pratique pour le badge "À valider" sur l'admin dashboard.
   */
  async getPendingVendors() {
    const vendors = await this.prisma.restaurant.findMany({
      where: { adminApproved: false },
      include: {
        owner: { select: { id: true, email: true, nom: true, phone: true } },
        vendorProfile: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return { data: vendors, total: vendors.length };
  }

  /**
   * Approuve un vendeur — délègue à VendorsService pour garder la logique
   * (event vendor.approved, audit trail) en un seul endroit.
   */
  async approveVendor(restaurantId: string, adminUserId: string) {
    return this.vendorsService.approveVendor(restaurantId, adminUserId);
  }

  /**
   * Suspend un vendeur : désactive (isActive=false) + ferme (isOpen=false).
   * Réversible via toggleRestaurantActive(id, true).
   *
   * On NE touche PAS à adminApproved — un vendeur peut être suspendu
   * temporairement sans repasser par toute la validation initiale.
   */
  async suspendVendor(restaurantId: string, reason: string, adminUserId: string) {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });
    if (!vendor) throw new NotFoundException('Vendeur introuvable.');
    if (!vendor.isActive) {
      throw new BadRequestException('Ce vendeur est déjà suspendu.');
    }

    const updated = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { isActive: false, isOpen: false },
    });

    this.logger.warn(
      `Vendeur ${vendor.nom} (${restaurantId}) suspendu par admin ${adminUserId} — raison: ${reason}`,
    );

    return {
      data: updated,
      message: 'Vendeur suspendu',
    };
  }

  /**
   * Réactive un vendeur suspendu : isActive=true. On NE rouvre PAS
   * automatiquement (isOpen) — c'est au restaurateur de rouvrir selon ses
   * horaires. Inverse réversible de `suspendVendor`.
   */
  async activateVendor(restaurantId: string, adminUserId: string) {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });
    if (!vendor) throw new NotFoundException('Vendeur introuvable.');
    if (vendor.isActive) {
      throw new BadRequestException('Ce vendeur est déjà actif.');
    }

    const updated = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { isActive: true },
    });

    this.logger.log(
      `Vendeur ${vendor.nom} (${restaurantId}) réactivé par admin ${adminUserId}`,
    );

    return {
      data: updated,
      message: 'Vendeur réactivé',
    };
  }
}
