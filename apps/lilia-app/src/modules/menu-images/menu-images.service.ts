import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PhotosCommonService } from '../photos-common/photos-common.service';
import {
  CreateMenuImageDto,
  UpdateMenuImageDto,
  ReorderMenuImagesDto,
} from './dto';

@Injectable()
export class MenuImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly common: PhotosCommonService,
  ) {}

  async list(menuDuJourId: string) {
    if (!menuDuJourId) {
      throw new BadRequestException('menuDuJourId requis');
    }
    return this.prisma.menuImage.findMany({
      where: { menuDuJourId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private async assertMenuOwnership(
    menuDuJourId: string,
    user: { id: string; role: string },
  ): Promise<string> {
    const menu = await this.prisma.menuDuJour.findUnique({
      where: { id: menuDuJourId },
      select: { restaurantId: true },
    });
    if (!menu) throw new NotFoundException('Menu introuvable');
    await this.common.assertRestaurantOwnership(menu.restaurantId, user);
    return menu.restaurantId;
  }

  async create(dto: CreateMenuImageDto, user: { id: string; role: string }) {
    await this.assertMenuOwnership(dto.menuDuJourId, user);
    await this.common.assertUnderMax('menuImage', { menuDuJourId: dto.menuDuJourId });

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover) {
        await tx.menuImage.updateMany({
          where: { menuDuJourId: dto.menuDuJourId, isCover: true },
          data: { isCover: false },
        });
      }
      return tx.menuImage.create({
        data: {
          menuDuJourId: dto.menuDuJourId,
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
    dto: UpdateMenuImageDto,
    user: { id: string; role: string },
  ) {
    const image = await this.prisma.menuImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Image introuvable');
    await this.assertMenuOwnership(image.menuDuJourId, user);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover === true) {
        await tx.menuImage.updateMany({
          where: { menuDuJourId: image.menuDuJourId, NOT: { id }, isCover: true },
          data: { isCover: false },
        });
      }
      return tx.menuImage.update({
        where: { id },
        data: {
          ...(dto.alt !== undefined && { alt: dto.alt }),
          ...(dto.displayOrder !== undefined && { displayOrder: dto.displayOrder }),
          ...(dto.isCover !== undefined && { isCover: dto.isCover }),
        },
      });
    });
  }

  async remove(id: string, user: { id: string; role: string }) {
    const image = await this.prisma.menuImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Image introuvable');
    await this.assertMenuOwnership(image.menuDuJourId, user);

    await this.prisma.menuImage.delete({ where: { id } });
    await this.common.cleanupCloudinary(image.publicId);
    return { success: true };
  }

  async reorder(dto: ReorderMenuImagesDto, user: { id: string; role: string }) {
    await this.assertMenuOwnership(dto.menuDuJourId, user);

    const images = await this.prisma.menuImage.findMany({
      where: { id: { in: dto.ids } },
      select: { id: true, menuDuJourId: true },
    });
    if (images.length !== dto.ids.length) {
      throw new BadRequestException('Certaines images sont introuvables');
    }
    const wrongOwner = images.find((p) => p.menuDuJourId !== dto.menuDuJourId);
    if (wrongOwner) {
      throw new BadRequestException(
        'Certaines images n\'appartiennent pas au menu cible',
      );
    }

    return this.prisma.$transaction(
      dto.ids.map((id, index) =>
        this.prisma.menuImage.update({
          where: { id },
          data: { displayOrder: index },
        }),
      ),
    );
  }
}
