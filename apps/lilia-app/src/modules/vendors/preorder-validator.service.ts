/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Product, Restaurant } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_PREORDER_DAYS = 7;

/** Shape minimum d'un item de panier pour la validation preorder. */
interface CartItemWithProduct {
  product: Pick<Product, 'madeToOrder' | 'nom'>;
}

@Injectable()
export class PreorderValidatorService {
  private readonly logger = new Logger(PreorderValidatorService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validation de preorder pilotée par les items du panier (LIL-121, décision 1b).
   *
   * Règle :
   *   - Si au moins un item a `madeToOrder=true` → preorder REQUIS, `scheduledFor`
   *     doit être fourni et valide (lead time vendeur, max 7 jours).
   *   - Si tous les items ont `madeToOrder=false` → preorder INTERDIT, on rejette
   *     `scheduledFor` (commande immédiate uniquement).
   *   - Si le panier mélange les deux → rejet (defense in depth pour 2a, le client
   *     devrait avoir bloqué côté UI ou côté `CartService.addItem`).
   */
  validatePreorderForCart(
    cartItems: CartItemWithProduct[],
    vendor: Restaurant,
    scheduledFor: Date | null | undefined,
  ): void {
    const madeToOrderCount = cartItems.filter(
      (item) => item.product.madeToOrder,
    ).length;
    const total = cartItems.length;

    // Cart mixte → rejet immédiat (frontend devrait empêcher)
    if (madeToOrderCount > 0 && madeToOrderCount < total) {
      throw new BadRequestException(
        'Votre panier mélange des produits immédiats et sur commande. ' +
          'Veuillez ne garder qu\'un seul type par commande.',
      );
    }

    const isPreorderCart = madeToOrderCount === total && total > 0;

    if (!isPreorderCart) {
      // Tous les produits sont immédiats. `scheduledFor` n'a pas de sens.
      if (scheduledFor) {
        throw new BadRequestException(
          'Cette commande ne contient pas de produits sur commande. ' +
            'Retirez la date de retrait pour passer une commande immédiate.',
        );
      }
      return;
    }

    // Cart preorder : on exige scheduledFor + on valide la fenêtre vendeur.
    if (!scheduledFor) {
      throw new BadRequestException(
        'Cette commande contient des produits sur commande. ' +
          'Veuillez indiquer la date et l\'heure de retrait souhaitées.',
      );
    }

    if (!vendor.acceptsPreorders) {
      throw new BadRequestException(
        `${vendor.nom} n'accepte pas les commandes planifiées.`,
      );
    }

    const leadHours = vendor.preorderLeadHours ?? 24;
    const now = Date.now();
    const minScheduledTime = new Date(now + leadHours * 3600 * 1000);
    const maxScheduledTime = new Date(
      now + MAX_PREORDER_DAYS * 24 * 3600 * 1000,
    );

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

  /**
   * @deprecated Utiliser `validatePreorderForCart` qui prend les items du panier
   * en compte (LIL-121). Conservé pour rétrocompatibilité éventuelle des call-sites
   * externes, mais OrdersService est désormais migré sur la nouvelle méthode.
   */
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
}
