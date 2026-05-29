/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Restaurant } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_PREORDER_DAYS = 7;

@Injectable()
export class PreorderValidatorService {
  private readonly logger = new Logger(PreorderValidatorService.name);

  constructor(private readonly prisma: PrismaService) {}

  validatePreorderRequest(
    scheduledFor: Date | null | undefined,
    vendor: Restaurant,
  ): void {
    if (!scheduledFor) return;

    if (!vendor.acceptsPreorders) {
      throw new BadRequestException(
        `${vendor.nom} n'accepte pas les commandes planifiées.`,
      );
    }

    const leadHours = vendor.preorderLeadHours ?? 24;
    const now = Date.now();
    const minScheduledTime = new Date(now + leadHours * 3600 * 1000);
    const maxScheduledTime = new Date(now + MAX_PREORDER_DAYS * 24 * 3600 * 1000);

    if (scheduledFor < minScheduledTime) {
      throw new BadRequestException(
        `Les commandes doivent être planifiées au moins ${leadHours}h à l'avance pour ${vendor.nom}. ` +
          `Prochain créneau disponible : ${minScheduledTime.toLocaleString('fr-FR')}.`,
      );
    }
    if (scheduledFor > maxScheduledTime) {
      throw new BadRequestException(
        `Impossible de planifier une commande à plus de ${MAX_PREORDER_DAYS} jours.`,
      );
    }
  }

  async validateDailyCapacity(vendor: Restaurant): Promise<void> {
    if (!vendor.maxOrdersPerDay) return;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const ordersToday = await this.prisma.order.count({
      where: {
        restaurantId: vendor.id,
        createdAt: { gte: todayStart },
        status: { notIn: ['ANNULER'] },
      },
    });

    if (ordersToday >= vendor.maxOrdersPerDay) {
      throw new BadRequestException(
        `${vendor.nom} a atteint sa capacité maximale pour aujourd'hui ` +
          `(${vendor.maxOrdersPerDay} commandes). Revenez demain.`,
      );
    }
  }

  async validateAgeForAlcohol(
    cartItems: { productId: string }[],
    vendor: Restaurant,
    ageVerified: boolean,
  ): Promise<void> {
    if (!vendor.minAgeRequired) return;

    const productIds = [...new Set(cartItems.map((i) => i.productId))];
    const alcoholCount = await this.prisma.product.count({
      where: { id: { in: productIds }, productType: 'ALCOHOL' },
    });

    if (alcoholCount > 0 && !ageVerified) {
      throw new BadRequestException(
        `Vous devez confirmer avoir ${vendor.minAgeRequired} ans ou plus ` +
          `pour commander des boissons alcoolisées.`,
      );
    }
  }
}
