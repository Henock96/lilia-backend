import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';

export const MAX_PHOTOS_PER_ENTITY = 5;

/**
 * Tables Prisma supportées par le service partagé. Chaque entrée doit
 * avoir un champ `restaurantId | productId | menuDuJourId`, un `isCover`
 * boolean, un `publicId` string?, et un `displayOrder` int.
 */
export type PhotoTable = 'vendorPhoto' | 'productImage' | 'menuImage';

@Injectable()
export class PhotosCommonService {
  private readonly logger = new Logger(PhotosCommonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /**
   * Vérifie que l'utilisateur peut muter une entité du restaurant cible.
   * ADMIN passe toujours. RESTAURATEUR doit être owner du restaurant.
   * Lance ForbiddenException sinon. NotFound si restaurant introuvable.
   */
  async assertRestaurantOwnership(
    restaurantId: string,
    user: { id: string; role: string },
  ): Promise<void> {
    if (user.role === 'ADMIN') return;
    const r = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { ownerId: true },
    });
    if (!r) throw new NotFoundException('Restaurant introuvable');
    if (r.ownerId !== user.id) {
      throw new ForbiddenException(
        "Vous n'êtes pas propriétaire de ce restaurant",
      );
    }
  }

  /**
   * Vérifie que le nombre de photos pour une entité ne dépasse pas la limite.
   * Lance BadRequestException si MAX atteint.
   */
  async assertUnderMax(table: PhotoTable, where: object): Promise<void> {
    const count = await this.countByEntity(table, where);
    if (count >= MAX_PHOTOS_PER_ENTITY) {
      throw new BadRequestException(
        `Maximum ${MAX_PHOTOS_PER_ENTITY} photos par entité`,
      );
    }
  }

  /**
   * Désactive `isCover` sur toutes les photos de l'entité sauf celle pointée.
   * Utilisé avant d'activer un nouveau cover pour garantir l'invariant
   * "au plus un cover par entité".
   * À appeler dans une transaction par le service appelant.
   */
  async demoteOtherCovers(
    table: PhotoTable,
    where: object,
    keepId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const filter = keepId ? { ...where, NOT: { id: keepId } } : where;
    const client = tx ?? this.prisma;
    // Accès dynamique à une table Prisma : le type exact dépend de `table`, on
    // décrit donc la seule méthode appelée plutôt que le fourre-tout `Function`.
    await (
      client[table] as { updateMany: (args: any) => Promise<unknown> }
    ).updateMany({
      where: { ...filter, isCover: true },
      data: { isCover: false },
    });
  }

  /**
   * Réattribue la photo principale après la suppression de celle qui la
   * portait.
   *
   * `demoteOtherCovers` garantissait « au plus un cover » ; rien ne garantissait
   * « au moins un cover tant qu'il reste une photo ». Supprimer la principale
   * laissait donc l'entité sans photo principale : plus aucune étoile dans le
   * back-office, et la case « photo de couverture » de la checklist
   * `VendorReadinessService` repassait en défaut sans qu'aucun geste ne l'ait
   * demandé.
   *
   * Promotion de la **première** restante, dans l'ordre d'affichage — le même
   * que celui déjà servi par les listes, donc la photo qui était affichée en
   * tête. On ne choisit rien de nouveau : on entérine ce qui était déjà montré.
   *
   * No-op s'il reste un cover (suppression d'une photo secondaire) ou plus
   * aucune photo.
   */
  async promoteNextCover(table: PhotoTable, where: object): Promise<void> {
    const model = this.prisma[table] as {
      findFirst: (args: any) => Promise<{ id: string } | null>;
      update: (args: any) => Promise<unknown>;
    };

    const existingCover = await model.findFirst({
      where: { ...where, isCover: true },
      select: { id: true },
    });
    if (existingCover) return;

    const next = await model.findFirst({
      where,
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    if (!next) return;

    await model.update({ where: { id: next.id }, data: { isCover: true } });
  }

  /**
   * Cleanup Cloudinary non-bloquant. Log warn si échec.
   */
  async cleanupCloudinary(publicId: string | null | undefined): Promise<void> {
    if (!publicId) return;
    try {
      await this.cloudinary.deleteImage(publicId);
    } catch (err) {
      this.logger.warn(
        `Cloudinary deleteImage failed for ${publicId}: ${(err as Error).message}`,
      );
    }
  }

  private async countByEntity(
    table: PhotoTable,
    where: object,
  ): Promise<number> {
    return (
      this.prisma[table] as { count: (args: any) => Promise<number> }
    ).count({ where });
  }
}
