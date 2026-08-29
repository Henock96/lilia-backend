// promo/promo.service.ts
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePromoCodeDto } from './dto/create-promo-code.dto';

export interface PromoValidationResult {
  valid: boolean;
  promoCodeId: string;
  code: string;
  discountType: string;
  discountAmount: number; // montant exact à déduire
  description: string;
  newTotal: number;
  newDeliveryFee: number;
}

@Injectable()
export class PromoService {
  private readonly logger = new Logger(PromoService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Validation ─────────────────────────────────────────────────────────────

  /**
   * Valide un code promo et calcule la réduction.
   * Appelé depuis l'app mobile à la checkout avant de confirmer la commande.
   * Ne consomme PAS le code — juste la validation.
   */
  /**
   * Aperçu de réduction, calculé sur le **panier réel** du client (fix L6).
   *
   * `POST /promo/validate` acceptait `subTotal` et `deliveryFee` depuis le
   * corps de la requête : le client pouvait donc sonder la remise d'un code
   * pour n'importe quel montant et contourner `minOrderAmount` — en aperçu
   * seulement (le checkout recalcule tout), mais c'était un oracle offert.
   * On lit désormais le panier serveur ; le body ne sert plus qu'au code.
   */
  async validateCodeForCart(
    code: string,
    userId: string,
  ): Promise<PromoValidationResult> {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: { product: true, variant: true, menu: true },
        },
      },
    });

    const items = cart?.items ?? [];
    if (items.length === 0) {
      throw new BadRequestException(
        'Votre panier est vide : impossible de valider un code promo.',
      );
    }

    const restaurantId = items[0].product.restaurantId;

    // Même règle de calcul que le checkout : un menu porte son propre prix,
    // les produits individuels celui de leur variante.
    const menuIds = new Set<string>();
    let subTotal = 0;
    for (const item of items) {
      if (item.menuId && item.menu) {
        if (menuIds.has(item.menuId)) continue;
        menuIds.add(item.menuId);
        subTotal += item.menu.prix * item.quantite;
      } else if (item.variant) {
        subTotal += item.variant.prix * item.quantite;
      }
    }

    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { fixedDeliveryFee: true },
    });

    return this.validateCode(
      code,
      userId,
      restaurantId,
      Math.round(subTotal),
      // Aperçu : en mode ZONE_BASED, l'adresse n'est pas encore choisie. Le
      // checkout recalculera le vrai montant.
      restaurant?.fixedDeliveryFee ?? 0,
    );
  }

  async validateCode(
    code: string,
    userId: string,
    restaurantId: string,
    subTotal: number,
    deliveryFee: number,
  ): Promise<PromoValidationResult> {
    const promo = await this.prisma.promoCode.findUnique({
      where: { code: code.toUpperCase().trim() },
      include: {
        usages: { where: { userId } }, // usages de CET utilisateur
        _count: { select: { usages: true } }, // total usages
      },
    });

    // ── Existence ──────────────────────────────────────────────────────
    if (!promo) {
      throw new NotFoundException(`Code "${code}" invalide ou introuvable.`);
    }

    // ── Actif ──────────────────────────────────────────────────────────
    if (!promo.isActive) {
      throw new BadRequestException("Ce code promo n'est plus actif.");
    }

    // ── Dates de validité ─────────────────────────────────────────────
    const now = new Date();
    if (now < promo.startsAt) {
      throw new BadRequestException("Ce code promo n'est pas encore actif.");
    }
    if (promo.expiresAt && now > promo.expiresAt) {
      throw new BadRequestException('Ce code promo a expiré.');
    }

    // ── Usage total ───────────────────────────────────────────────────
    if (
      promo.maxUsageTotal !== null &&
      promo._count.usages >= promo.maxUsageTotal
    ) {
      throw new BadRequestException(
        "Ce code promo a atteint son nombre maximal d'utilisations.",
      );
    }

    // ── Usage par user ────────────────────────────────────────────────
    if (promo.usages.length >= promo.maxUsagePerUser) {
      throw new BadRequestException('Vous avez déjà utilisé ce code promo.');
    }

    // ── Premier achat seulement ───────────────────────────────────────
    if (promo.firstOrderOnly) {
      const hasOrdered = await this.prisma.order.findFirst({
        where: {
          userId,
          status: { in: ['PAYER', 'EN_PREPARATION', 'PRET', 'LIVRER'] },
        },
      });
      if (hasOrdered) {
        throw new BadRequestException(
          'Ce code est réservé aux nouvelles inscriptions.',
        );
      }
    }

    // ── Restriction restaurant ────────────────────────────────────────
    if (promo.restaurantId && promo.restaurantId !== restaurantId) {
      throw new BadRequestException(
        "Ce code promo n'est pas valable pour ce restaurant.",
      );
    }

    // ── Montant minimum ───────────────────────────────────────────────
    if (subTotal < promo.minOrderAmount) {
      throw new BadRequestException(
        `Montant minimum requis : ${promo.minOrderAmount} FCFA. Votre panier : ${subTotal} FCFA.`,
      );
    }

    // ── Calcul de la réduction ────────────────────────────────────────
    const { discountAmount, newDeliveryFee } = this.calculateDiscount(
      promo,
      subTotal,
      deliveryFee,
    );

    const newTotal = Math.max(0, subTotal + newDeliveryFee - discountAmount);

    this.logger.log(
      `Code "${code}" validé pour user ${userId} — réduction : ${discountAmount} FCFA`,
    );

    return {
      valid: true,
      promoCodeId: promo.id,
      code: promo.code,
      discountType: promo.discountType,
      discountAmount,
      description: promo.description ?? '',
      newTotal,
      newDeliveryFee,
    };
  }

  /**
   * Consomme le code promo lors de la création de commande.
   * Appelé DANS la transaction de createOrderFromCart.
   * Enregistre l'usage pour éviter la réutilisation.
   */
  async applyCode(
    tx: any, // Prisma TransactionClient
    promoCodeId: string,
    userId: string,
    orderId: string,
    discountAmount: number,
  ): Promise<void> {
    // Verrou pessimiste sur la ligne PromoCode : sérialise les utilisations
    // concurrentes du MÊME code (double-tap, retry réseau, scripts). Sans ce
    // verrou, deux checkouts simultanés passent tous deux la validation lue en
    // amont et consomment le code deux fois (faille de double-spend).
    const locked = await tx.$queryRaw<
      { id: string; maxUsageTotal: number | null; maxUsagePerUser: number }[]
    >`
      SELECT id, "maxUsageTotal", "maxUsagePerUser"
      FROM "PromoCode"
      WHERE id = ${promoCodeId}
      FOR UPDATE
    `;

    if (!locked || locked.length === 0) {
      throw new NotFoundException('Code promo introuvable.');
    }
    const promo = locked[0];

    // Re-vérification des quotas SOUS verrou — les count() voient désormais les
    // usages déjà committés par une transaction concurrente terminée avant nous.
    if (promo.maxUsageTotal !== null) {
      const totalUsages = await tx.promoUsage.count({ where: { promoCodeId } });
      if (totalUsages >= promo.maxUsageTotal) {
        throw new BadRequestException(
          "Ce code promo a atteint son nombre maximal d'utilisations.",
        );
      }
    }

    const userUsages = await tx.promoUsage.count({
      where: { promoCodeId, userId },
    });
    if (userUsages >= promo.maxUsagePerUser) {
      throw new BadRequestException('Vous avez déjà utilisé ce code promo.');
    }

    await tx.promoUsage.create({
      data: {
        promoCodeId,
        userId,
        orderId,
        discountApplied: discountAmount,
      },
    });
  }

  // ─── Calcul ──────────────────────────────────────────────────────────────────

  private calculateDiscount(
    promo: any,
    subTotal: number,
    deliveryFee: number,
  ): { discountAmount: number; newDeliveryFee: number } {
    switch (promo.discountType) {
      case 'FIXED': {
        // Réduction fixe sur le subTotal
        const discount = Math.min(promo.discountValue, subTotal);
        return {
          discountAmount: Math.round(discount),
          newDeliveryFee: deliveryFee,
        };
      }

      case 'PERCENT': {
        // Pourcentage sur le subTotal, plafonné si maxDiscount défini
        let discount = subTotal * (promo.discountValue / 100);
        if (promo.maxDiscount !== null) {
          discount = Math.min(discount, promo.maxDiscount);
        }
        return {
          discountAmount: Math.round(discount),
          newDeliveryFee: deliveryFee,
        };
      }

      case 'FREE_DELIVERY': {
        // Livraison gratuite — la réduction = deliveryFee
        return { discountAmount: 0, newDeliveryFee: 0 };
      }

      default:
        return { discountAmount: 0, newDeliveryFee: deliveryFee };
    }
  }

  // ─── CRUD Admin ──────────────────────────────────────────────────────────────

  async create(dto: CreatePromoCodeDto) {
    // Le code est toujours uppercase pour éviter les erreurs de casse
    const code = dto.code.toUpperCase().trim();

    const existing = await this.prisma.promoCode.findUnique({
      where: { code },
    });
    if (existing) {
      throw new BadRequestException(`Le code "${code}" existe déjà.`);
    }

    const promo = await this.prisma.promoCode.create({
      data: {
        ...dto,
        code,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : new Date(),
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
    });

    return { data: promo, message: 'Code promo créé' };
  }

  async findAll(activeOnly = false) {
    const promos = await this.prisma.promoCode.findMany({
      where: activeOnly ? { isActive: true } : {},
      include: { _count: { select: { usages: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { data: promos };
  }

  async toggle(id: string) {
    const promo = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!promo) throw new NotFoundException('Code promo introuvable');

    const updated = await this.prisma.promoCode.update({
      where: { id },
      data: { isActive: !promo.isActive },
    });
    return {
      data: updated,
      message: updated.isActive ? 'Activé' : 'Désactivé',
    };
  }

  async remove(id: string) {
    const promo = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!promo) throw new NotFoundException('Code promo introuvable');
    await this.prisma.$transaction([
      this.prisma.promoUsage.deleteMany({ where: { promoCodeId: id } }),
      this.prisma.promoCode.delete({ where: { id } }),
    ]);
    return { message: 'Code promo supprimé' };
  }

  async getStats(id: string) {
    const promo = await this.prisma.promoCode.findUnique({
      where: { id },
      include: {
        _count: { select: { usages: true } },
        usages: { select: { discountApplied: true } },
      },
    });
    if (!promo) throw new NotFoundException();

    const totalDiscount = promo.usages.reduce(
      (sum, u) => sum + u.discountApplied,
      0,
    );

    return {
      data: {
        code: promo.code,
        totalUsages: promo._count.usages,
        maxUsage: promo.maxUsageTotal ?? 'illimité',
        totalDiscountGiven: totalDiscount,
        remainingUsages: promo.maxUsageTotal
          ? promo.maxUsageTotal - promo._count.usages
          : 'illimité',
      },
    };
  }
}
