/* eslint-disable prettier/prettier */
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Cycle de vie des menus (extrait de MenusService — LIL-141).
 *
 * Opérations légères sur un menu existant : suppression (avec nettoyage du
 * produit phantom pour les PLAT_SPECIAL), mise à jour du stock et activation.
 * Séparé de MenuCommandService (authoring) pour rester sous la cible ~400 LOC.
 */
@Injectable()
export class MenuLifecycleService {
  private readonly logger = new Logger(MenuLifecycleService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Supprimer un menu
   * Pour PLAT_SPECIAL, supprime aussi le produit phantom associe
   */
  async remove(id: string, firebaseUid: string) {
    // 1. Vérifier que le menu existe
    const menu = await this.prisma.menuDuJour.findUnique({
      where: { id },
      include: {
        restaurant: {
          include: {
            owner: true,
          },
        },
        products: true,
      },
    });

    if (!menu) {
      throw new NotFoundException('Menu non trouvé');
    }

    // 2. Vérifier que l'utilisateur est le propriétaire du restaurant
    if (menu.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException(
        'Vous n\'êtes pas autorisé à supprimer ce menu',
      );
    }

    // 3. Si PLAT_SPECIAL, recuperer l'ID du produit phantom avant suppression
    const phantomProductId =
      menu.type === 'PLAT_SPECIAL' && menu.products.length > 0
        ? menu.products[0].productId
        : null;

    // 4. Supprimer le menu (cascade sur MenuProduct)
    await this.prisma.menuDuJour.delete({
      where: { id },
    });

    // 5. Supprimer le produit phantom si PLAT_SPECIAL
    if (phantomProductId) {
      try {
        // Supprimer les variantes puis le produit
        await this.prisma.productVariant.deleteMany({
          where: { productId: phantomProductId },
        });
        await this.prisma.product.delete({
          where: { id: phantomProductId },
        });
        this.logger.log(
          `🗑️ Produit phantom ${phantomProductId} supprime avec le menu PLAT_SPECIAL ${id}`,
        );
      } catch (error) {
        // Le produit phantom peut etre reference par des commandes passees,
        // dans ce cas on le laisse (orphelin mais necessaire pour l'historique)
      }
    }

    return {
      message: 'Menu supprimé avec succès',
    };
  }

  /**
   * Met à jour le stock d'un menu
   */
  async updateStock(menuId: string, stockQuotidien: number | null, firebaseUid: string) {
    const menu = await this.prisma.menuDuJour.findUnique({
      where: { id: menuId },
      include: { restaurant: { include: { owner: true } } },
    });

    if (!menu) {
      throw new NotFoundException('Menu non trouvé');
    }

    const user = await this.prisma.user.findFirst({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    if (user.role !== 'ADMIN' && menu.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException(
        'Vous n\'êtes pas autorisé à modifier le stock de ce menu',
      );
    }

    const updated = await this.prisma.menuDuJour.update({
      where: { id: menuId },
      data: {
        stockQuotidien: stockQuotidien,
        stockRestant: stockQuotidien,
      },
    });

    return {
      message: 'Stock du menu mis à jour avec succès',
      data: updated,
    };
  }

  /**
   * Désactiver/activer un menu
   */
  async toggleActive(id: string, firebaseUid: string) {
    const menu = await this.prisma.menuDuJour.findUnique({
      where: { id },
      include: {
        restaurant: {
          include: {
            owner: true,
          },
        },
      },
    });

    if (!menu) {
      throw new NotFoundException('Menu non trouvé');
    }

    if (menu.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException(
        'Vous n\'êtes pas autorisé à modifier ce menu',
      );
    }

    const updatedMenu = await this.prisma.menuDuJour.update({
      where: { id },
      data: {
        isActive: !menu.isActive,
      },
    });

    return {
      message: `Menu ${updatedMenu.isActive ? 'activé' : 'désactivé'} avec succès`,
      data: updatedMenu,
    };
  }
}
