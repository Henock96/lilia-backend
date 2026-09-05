import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';
import { PhotosCommonService } from '../photos-common/photos-common.service';
import {
  CreateVendorPhotoDto,
  UpdateVendorPhotoDto,
  ReorderVendorPhotosDto,
} from './dto';

@Injectable()
export class VendorPhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly common: PhotosCommonService,
  ) {}

  /**
   * Galerie publique d'un vendeur.
   *
   * Le filtre de visibilité manquait : la route est `@Public()` et rendait la
   * galerie de n'importe quel vendeur par son seul identifiant — y compris un
   * vendeur en cours de configuration, en attente de validation ou suspendu.
   * Les identifiants étant publics via `GET /vendors`, la frontière marketplace
   * était contournable de l'extérieur pour ce type de contenu.
   *
   * Même condition que `VendorsService.findOne` et `RestaurantQueryService` :
   * une seule définition de « visible du client », appliquée partout.
   */
  async list(restaurantId: string) {
    if (!restaurantId) {
      throw new BadRequestException('restaurantId requis');
    }
    const visible = await this.prisma.restaurant.findFirst({
      where: {
        id: restaurantId,
        ...PUBLIC_VENDOR_WHERE,
      },
      select: { id: true },
    });
    if (!visible) return [];

    return this.prisma.vendorPhoto.findMany({
      where: { restaurantId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Galerie vue par son propriétaire ou un administrateur, sans filtre de
   * visibilité : pendant l'onboarding, le vendeur doit voir les photos qu'il
   * vient d'ajouter alors même que sa boutique n'est pas encore publiée.
   */
  async listForOwner(restaurantId: string, user: { id: string; role: string }) {
    if (!restaurantId) {
      throw new BadRequestException('restaurantId requis');
    }
    await this.common.assertRestaurantOwnership(restaurantId, user);
    return this.prisma.vendorPhoto.findMany({
      where: { restaurantId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(dto: CreateVendorPhotoDto, user: { id: string; role: string }) {
    await this.common.assertRestaurantOwnership(dto.restaurantId, user);
    await this.common.assertUnderMax('vendorPhoto', {
      restaurantId: dto.restaurantId,
    });

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover) {
        await this.common.demoteOtherCovers(
          'vendorPhoto',
          { restaurantId: dto.restaurantId },
          null,
          tx,
        );
      }
      return tx.vendorPhoto.create({
        data: {
          restaurantId: dto.restaurantId,
          url: dto.url,
          publicId: dto.publicId ?? null,
          alt: dto.alt ?? null,
          isCover: dto.isCover ?? false,
        },
      });
    });
  }

  async update(
    id: string,
    dto: UpdateVendorPhotoDto,
    user: { id: string; role: string },
  ) {
    const photo = await this.prisma.vendorPhoto.findUnique({ where: { id } });
    if (!photo) throw new NotFoundException('Photo introuvable');
    await this.common.assertRestaurantOwnership(photo.restaurantId, user);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover === true) {
        await this.common.demoteOtherCovers(
          'vendorPhoto',
          { restaurantId: photo.restaurantId },
          id,
          tx,
        );
      }
      return tx.vendorPhoto.update({
        where: { id },
        data: {
          ...(dto.alt !== undefined && { alt: dto.alt }),
          ...(dto.displayOrder !== undefined && {
            displayOrder: dto.displayOrder,
          }),
          ...(dto.isCover !== undefined && { isCover: dto.isCover }),
        },
      });
    });
  }

  async remove(id: string, user: { id: string; role: string }) {
    const photo = await this.prisma.vendorPhoto.findUnique({ where: { id } });
    if (!photo) throw new NotFoundException('Photo introuvable');
    await this.common.assertRestaurantOwnership(photo.restaurantId, user);

    await this.prisma.vendorPhoto.delete({ where: { id } });
    await this.common.promoteNextCover('vendorPhoto', {
      restaurantId: photo.restaurantId,
    });
    await this.common.cleanupCloudinary(photo.publicId);
    return { success: true };
  }

  async reorder(
    dto: ReorderVendorPhotosDto,
    user: { id: string; role: string },
  ) {
    await this.common.assertRestaurantOwnership(dto.restaurantId, user);

    const photos = await this.prisma.vendorPhoto.findMany({
      where: { id: { in: dto.ids } },
      select: { id: true, restaurantId: true },
    });
    if (photos.length !== dto.ids.length) {
      throw new BadRequestException('Certaines photos sont introuvables');
    }
    const wrongOwner = photos.find((p) => p.restaurantId !== dto.restaurantId);
    if (wrongOwner) {
      throw new BadRequestException(
        "Certaines photos n'appartiennent pas au restaurant cible",
      );
    }

    return this.prisma.$transaction(
      dto.ids.map((id, index) =>
        this.prisma.vendorPhoto.update({
          where: { id },
          data: { displayOrder: index },
        }),
      ),
    );
  }
}
