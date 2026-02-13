import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';

@Injectable()
export class BannersService {
  constructor(private prisma: PrismaService) {}

  async findAll(restaurantId?: string) {
    const where: any = { isActive: true };
    if (restaurantId) {
      where.restaurantId = restaurantId;
    }

    const banners = await this.prisma.banner.findMany({
      where,
      orderBy: { displayOrder: 'asc' },
    });

    return { data: banners, message: 'Bannières récupérées avec succès' };
  }

  async findOne(id: string) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner) {
      throw new NotFoundException('Bannière non trouvée');
    }
    return { data: banner, message: 'Bannière récupérée avec succès' };
  }

  async create(dto: CreateBannerDto, firebaseUid: string) {
    await this.verifyPermission(firebaseUid, dto.restaurantId);

    const banner = await this.prisma.banner.create({
      data: {
        title: dto.title,
        imageUrl: dto.imageUrl,
        description: dto.description,
        linkUrl: dto.linkUrl,
        isActive: dto.isActive ?? true,
        displayOrder: dto.displayOrder ?? 0,
        restaurantId: dto.restaurantId,
      },
    });

    return { data: banner, message: 'Bannière créée avec succès' };
  }

  async update(id: string, dto: UpdateBannerDto, firebaseUid: string) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner) {
      throw new NotFoundException('Bannière non trouvée');
    }

    await this.verifyPermission(firebaseUid, banner.restaurantId);

    const updated = await this.prisma.banner.update({
      where: { id },
      data: dto,
    });

    return { data: updated, message: 'Bannière mise à jour avec succès' };
  }

  async remove(id: string, firebaseUid: string) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner) {
      throw new NotFoundException('Bannière non trouvée');
    }

    await this.verifyPermission(firebaseUid, banner.restaurantId);

    await this.prisma.banner.delete({ where: { id } });

    return { data: null, message: 'Bannière supprimée avec succès' };
  }

  async reorder(id: string, displayOrder: number, firebaseUid: string) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner) {
      throw new NotFoundException('Bannière non trouvée');
    }

    await this.verifyPermission(firebaseUid, banner.restaurantId);

    const updated = await this.prisma.banner.update({
      where: { id },
      data: { displayOrder },
    });

    return { data: updated, message: 'Ordre mis à jour avec succès' };
  }

  private async verifyPermission(firebaseUid: string, restaurantId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    if (user.role === 'ADMIN') return;

    if (restaurantId) {
      const restaurant = await this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
      });

      if (!restaurant || restaurant.ownerId !== user.id) {
        throw new ForbiddenException(
          "Vous n'êtes pas autorisé à gérer les bannières de ce restaurant",
        );
      }
    }
  }
}
