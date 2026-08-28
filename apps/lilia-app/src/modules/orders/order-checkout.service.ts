import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderCreatedEvent } from '../events/order-events';
import { PromoService, PromoValidationResult } from '../promo/promo.service';
import { OrderValidatorService } from './order-validator.service';
import { OrderCalculatorService } from './order-calculator.service';
import { StockService } from './stock.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreorderValidatorService } from '../vendors/preorder-validator.service';
import { QuartiersService } from '../quartiers/quartiers.service';

/**
 * Checkout : création d'une commande à partir du panier (LIL-134).
 *
 * Extrait de `OrdersService` pour isoler le cas d'usage le plus complexe
 * (idempotency Redis, validations, calcul, promo, fidélité, transaction,
 * event order.created, récompense parrainage). `OrdersService` y délègue
 * `createOrderFromCart` — l'API publique reste inchangée.
 */
@Injectable()
export class OrderCheckoutService {
  private readonly logger = new Logger(OrderCheckoutService.name);

  /** Marqueur d'une clé d'idempotence réservée mais dont le traitement court. */
  private static readonly PENDING = '__pending__';
  /** Durée de la réservation : au-delà, on considère le traitement perdu. */
  private static readonly PENDING_TTL_SECONDS = 120;
  /** Durée de conservation de la réponse pour rejouer un retry client. */
  private static readonly RESULT_TTL_SECONDS = 3600;

  private readonly idempotencyEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly validator: OrderValidatorService,
    private readonly calculator: OrderCalculatorService,
    private readonly promoService: PromoService,
    private readonly stockService: StockService,
    private readonly config: ConfigService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly preorderValidator: PreorderValidatorService,
    private readonly quartiersService: QuartiersService,
    // Client partagé fourni par `RedisModule.forRootAsync` (app.module). On
    // n'ouvre plus une seconde connexion ici : Render plafonne les connexions
    // Redis et `UserCacheService` utilise déjà ce même pool.
    @Optional() @InjectRedis() private readonly redis?: Redis,
  ) {
    this.idempotencyEnabled = Boolean(
      this.config.get<string>('REDIS_URL') && this.redis,
    );
  }

  /**
   * Point d'entrée du checkout, avec garde d'idempotence **atomique**.
   *
   * La clé est réservée en `SET NX` **avant** tout traitement : deux requêtes
   * concurrentes portant la même `Idempotency-Key` (double-tap, retry du
   * `RetryInterceptor` client) ne peuvent plus créer deux commandes. La
   * seconde reçoit un 409 tant que la première tourne, puis la réponse cachée
   * une fois celle-ci terminée.
   *
   * En cas d'échec du traitement, la réservation est libérée pour qu'un vrai
   * retry reste possible.
   */
  async createOrderFromCart(
    firebaseUid: string,
    dto: CreateOrderDto,
    idempotencyKey?: string,
  ) {
    const cacheKey =
      idempotencyKey && this.idempotencyEnabled
        ? `idempotency:${firebaseUid}:${idempotencyKey}`
        : null;

    if (!cacheKey) {
      return this.performCheckout(firebaseUid, dto);
    }

    const claim = await this.claimIdempotencyKey(cacheKey, idempotencyKey!);
    if (claim.replay) {
      this.logger.log(
        `📦 [IDEMPOTENCY] Réponse cachée retournée — key: ${idempotencyKey}`,
      );
      return claim.replay;
    }

    try {
      const result = await this.performCheckout(firebaseUid, dto);
      await this.storeIdempotentResult(cacheKey, result);
      return result;
    } catch (err) {
      // Le traitement a échoué : on relâche la réservation, sinon le client
      // resterait bloqué en 409 pendant 2 min sur une commande jamais créée.
      if (claim.reserved) {
        await this.redis
          ?.del(cacheKey)
          .catch(() => this.logger.warn('Libération clé idempotence échouée'));
      }
      throw err;
    }
  }

  private async performCheckout(firebaseUid: string, dto: CreateOrderDto) {
    const {
      adresseId,
      paymentMethod,
      notes,
      isDelivery = true,
      contactPhone,
      promoCode,
      useLoyaltyPoints,
      deliveryLatitude,
      deliveryLongitude,
      isPreorder,
      scheduledFor,
    } = dto;
    const scheduledForDate = scheduledFor ? new Date(scheduledFor) : null;

    this.logger.log(
      `📦 [COMMANDE] Début création commande - user: ${firebaseUid}, payload: ${JSON.stringify({ adresseId: dto.adresseId, paymentMethod: dto.paymentMethod, isDelivery: dto.isDelivery })}`,
    );
    // 1. Validation — tout dans le validator, propre et testable
    const user = await this.validator.validateAndGetUser(firebaseUid);
    const cartItems = user.cart?.items ?? [];
    this.validator.validateCartNotEmpty(cartItems);
    const restaurantId = this.validator.validateSameRestaurant(cartItems);

    // 1. Vérifier l'adresse de livraison (seulement si c'est une livraison)
    let deliveryAddress: string | null = null;

    if (isDelivery) {
      if (!adresseId) {
        this.logger.warn(
          `📦 [COMMANDE] Échec: adresse manquante pour livraison - user: ${user.id}`,
        );
        throw new BadRequestException(
          'Une adresse de livraison est requise pour la livraison à domicile.',
        );
      }
      deliveryAddress = await this.validator.validateDeliveryAddress(
        adresseId,
        user.id,
      );
    } else {
      this.logger.log(`📦 [COMMANDE] Mode retrait au restaurant`);
    }
    const restaurant =
      await this.validator.validateRestaurantOpen(restaurantId);
    await this.validator.validateStock(cartItems);

    // Multi-vendeurs (LIL-112 + LIL-121 décision 1b)
    // Validation pilotée par les items du panier : preorder requis ssi au moins
    // un produit a `madeToOrder=true`, et rejet du mix immédiat/sur commande.
    this.preorderValidator.validatePreorderForCart(
      cartItems,
      restaurant,
      scheduledForDate,
    );
    await this.preorderValidator.validateDailyCapacity(restaurant);

    // Frais de livraison : FIXED par défaut, ZONE_BASED selon le quartier de
    // l'adresse de livraison (le mode ZONE_BASED n'était jamais appliqué — B11).
    let effectiveDeliveryFee = restaurant.fixedDeliveryFee;
    let deliveryQuartierId: string | null = null;
    if (
      isDelivery &&
      restaurant.deliveryPriceMode === 'ZONE_BASED' &&
      adresseId
    ) {
      const addr = await this.prisma.adresses.findUnique({
        where: { id: adresseId },
        select: { quartierId: true },
      });
      if (addr?.quartierId) {
        deliveryQuartierId = addr.quartierId;
        const zoneFee = await this.quartiersService.calculateDeliveryFee(
          restaurantId,
          addr.quartierId,
        );
        effectiveDeliveryFee = zoneFee.fee;
      }
    }

    // 2. Calcul — isolé, testable unitairement
    const settings = await this.platformSettings.getSettings();
    const amounts = this.calculator.calculate(
      cartItems,
      effectiveDeliveryFee,
      isDelivery,
      settings.serviceFeePercent,
    );
    this.validator.validateMinimumOrderAmount(
      amounts.subTotal,
      restaurant.minimumOrderAmount,
      restaurant.nom,
    );
    const itemSnapshots = this.calculator.buildOrderItemSnapshots(cartItems);
    // Validation et calcul promo AVANT la transaction
    let promoResult: PromoValidationResult | null = null;
    if (promoCode) {
      promoResult = await this.promoService.validateCode(
        promoCode,
        user.id,
        restaurantId,
        amounts.subTotal,
        amounts.deliveryFee,
      );
    }

    // Montants finaux après promo
    const finalDeliveryFee = promoResult?.newDeliveryFee ?? amounts.deliveryFee;
    const discountAmount = promoResult?.discountAmount ?? 0;

    // Réduction points de fidélité — plafonnée au montant encore dû après promo.
    // On ne consomme JAMAIS plus de points que nécessaire (évite la perte de
    // valeur sur une petite commande payée avec un gros solde de points).
    let loyaltyDiscount = 0;
    let loyaltyPointsUsed = 0;
    if (useLoyaltyPoints) {
      const userPoints = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { loyaltyPoints: true },
      });
      const pts = userPoints?.loyaltyPoints ?? 0;
      if (pts >= settings.loyaltyMinRedemption) {
        // Montant restant à payer une fois la promo appliquée
        const remaining = Math.max(
          0,
          amounts.subTotal +
            finalDeliveryFee +
            amounts.serviceFee -
            discountAmount,
        );
        // Nombre de points effectivement utilisables (entier, plafonné au solde
        // ET au montant dû)
        loyaltyPointsUsed = Math.min(
          pts,
          Math.floor(remaining / settings.loyaltyPointValueXaf),
        );
        loyaltyDiscount = loyaltyPointsUsed * settings.loyaltyPointValueXaf;
      }
    }

    const finalTotal = Math.max(
      0,
      amounts.subTotal +
        finalDeliveryFee +
        amounts.serviceFee -
        discountAmount -
        loyaltyDiscount,
    );
    // 5. Exécuter la création de la commande et la suppression du panier dans une transaction
    const order = await this.prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          userId: user.id,
          restaurantId,
          subTotal: amounts.subTotal,
          deliveryFee: finalDeliveryFee,
          serviceFee: amounts.serviceFee,
          discountAmount: discountAmount + loyaltyDiscount,
          total: finalTotal,
          promoCodeId: promoResult?.promoCodeId ?? null,
          isDelivery,
          notes,
          contactPhone,
          deliveryAddress,
          deliveryLatitude: deliveryLatitude ?? null,
          deliveryLongitude: deliveryLongitude ?? null,
          deliveryQuartierId,
          paymentMethod,
          status: 'EN_ATTENTE',
          isPreorder: isPreorder ?? Boolean(scheduledForDate),
          scheduledFor: scheduledForDate,
          items: {
            create: itemSnapshots.map((snap) => ({
              productId: snap.productId,
              menuId: snap.menuId,
              quantite: snap.quantite,
              prix: snap.prix,
              variant: snap.variant,
              variantId: snap.variantId,
              snapshotPrice: snap.snapshotPrice,
            })),
          },
        },
        include: {
          items: true,
          restaurant: { select: { nom: true } }, // Correction: Toujours inclure le restaurant
        },
      });
      // Consomme le code promo dans la transaction
      if (promoResult) {
        await this.promoService.applyCode(
          tx,
          promoResult.promoCodeId,
          user.id,
          newOrder.id,
          discountAmount,
        );
      }

      // Consomme les points de fidélité dans la transaction — uniquement le
      // nombre réellement utilisé (calculé et plafonné plus haut).
      //
      // Le décrément est CONDITIONNEL (`WHERE "loyaltyPoints" >= n`) : le solde
      // lu plus haut l'a été hors transaction, donc deux checkouts concurrents
      // du même utilisateur (mobile + web, ou double device) peuvent tous deux
      // avoir vu le même solde. Sans cette garde, le solde passerait en négatif
      // et la réduction serait accordée deux fois. Le second checkout affecte
      // 0 ligne → on lève, ce qui rollback toute la transaction (commande,
      // promo, stock, panier). Même esprit que le `SELECT … FOR UPDATE` de
      // `promo.service.applyCode`.
      if (loyaltyPointsUsed > 0) {
        const updatedRows = await tx.$executeRaw`
          UPDATE "User"
          SET "loyaltyPoints" = "loyaltyPoints" - ${loyaltyPointsUsed}
          WHERE id = ${user.id} AND "loyaltyPoints" >= ${loyaltyPointsUsed}
        `;
        if (updatedRows === 0) {
          throw new BadRequestException(
            'Solde de points de fidélité insuffisant. Votre solde a changé, merci de recommencer la commande.',
          );
        }
        await tx.loyaltyTransaction.create({
          data: {
            userId: user.id,
            orderId: newOrder.id,
            points: -loyaltyPointsUsed,
            reason: `${loyaltyPointsUsed} pts utilisés — réduction ${loyaltyDiscount} FCFA`,
          },
        });
      }

      // 6. Décrémenter le stock des produits et menus commandés
      await this.stockService.decrementInTransaction(tx, cartItems);

      // 7. Vider le panier
      await tx.cartItem.deleteMany({
        where: {
          cartId: user.cart!.id,
        },
      });

      return newOrder;
    });
    this.logger.log(
      `🔔 Nouvelles commandes:${order.id} au restaurant ${order.restaurantId} pour un total de ${order.total} FCFA.`,
    );
    // 🔥 ÉMETTRE L'ÉVÉNEMENT au lieu d'appeler directement les notifications
    const orderCreatedEvent = new OrderCreatedEvent(
      order.id,
      order.userId,
      order.restaurantId,
      {
        totalAmount: order.total,
        itemCount: order.items.length,
        restaurantName: order.restaurant.nom, // Exemple statique, à remplacer par une vraie estimation si disponible
      },
    );

    this.eventEmitter.emit('order.created', orderCreatedEvent);

    // Récompense parrainage sur la 1ère commande (non-bloquant)
    this.handleReferralReward(user.id).catch((err) =>
      this.logger.error(`Erreur récompense parrainage: ${err}`),
    );

    return { message: 'Commande créée avec succès.', data: order };
  }

  /**
   * Réserve la clé d'idempotence de façon atomique.
   *
   * - `SET NX` réussit → on est le premier, on peut traiter (`reserved: true`).
   * - La clé porte une réponse → c'est un retry légitime, on la rejoue.
   * - La clé est encore en `__pending__` → un traitement est en cours, 409.
   *
   * Si Redis est indisponible, on dégrade en best-effort (traitement sans
   * garde) plutôt que de refuser la commande : c'était déjà le comportement
   * historique, et une panne Redis ne doit pas fermer la caisse.
   */
  private async claimIdempotencyKey(
    cacheKey: string,
    idempotencyKey: string,
  ): Promise<{ reserved: boolean; replay?: unknown }> {
    try {
      const reserved = await this.redis!.set(
        cacheKey,
        OrderCheckoutService.PENDING,
        'EX',
        OrderCheckoutService.PENDING_TTL_SECONDS,
        'NX',
      );
      if (reserved === 'OK') return { reserved: true };

      const existing = await this.redis!.get(cacheKey);

      // Expirée entre le SET et le GET : on retente une fois de la réserver.
      if (existing === null) {
        const retry = await this.redis!.set(
          cacheKey,
          OrderCheckoutService.PENDING,
          'EX',
          OrderCheckoutService.PENDING_TTL_SECONDS,
          'NX',
        );
        if (retry === 'OK') return { reserved: true };
        throw new ConflictException(
          'Une commande identique est déjà en cours de traitement.',
        );
      }

      if (existing === OrderCheckoutService.PENDING) {
        this.logger.warn(
          `📦 [IDEMPOTENCY] Requête concurrente rejetée — key: ${idempotencyKey}`,
        );
        throw new ConflictException(
          'Une commande identique est déjà en cours de traitement.',
        );
      }

      return { reserved: false, replay: JSON.parse(existing) };
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      this.logger.error(
        `Redis (idempotence checkout) indisponible — checkout non protégé : ${
          (err as Error).message
        }`,
      );
      return { reserved: false };
    }
  }

  private async storeIdempotentResult(cacheKey: string, result: unknown) {
    await this.redis
      ?.setex(
        cacheKey,
        OrderCheckoutService.RESULT_TTL_SECONDS,
        JSON.stringify(result),
      )
      .catch(() =>
        this.logger.warn('Mise en cache du résultat idempotent échouée'),
      );
  }

  private async handleReferralReward(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referredByCode: true, referralRewarded: true },
    });
    if (!user?.referredByCode || user.referralRewarded) return;

    const orderCount = await this.prisma.order.count({ where: { userId } });
    if (orderCount !== 1) return;

    const referrer = await this.prisma.user.findUnique({
      where: { referralCode: user.referredByCode },
      select: { id: true },
    });
    if (!referrer) return;

    const settings = await this.platformSettings.getSettings();

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: referrer.id },
        data: { loyaltyPoints: { increment: settings.referrerBonusPoints } },
      }),
      this.prisma.loyaltyTransaction.create({
        data: {
          userId: referrer.id,
          points: settings.referrerBonusPoints,
          reason: 'Récompense parrainage — filleul activé',
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          loyaltyPoints: { increment: settings.referredBonusPoints },
          referralRewarded: true,
        },
      }),
      this.prisma.loyaltyTransaction.create({
        data: {
          userId,
          points: settings.referredBonusPoints,
          reason: 'Bonus bienvenue parrainage',
        },
      }),
    ]);

    this.logger.log(
      `🎁 Parrainage: +${settings.referrerBonusPoints}pts → parrain ${referrer.id}, +${settings.referredBonusPoints}pts → filleul ${userId}`,
    );
  }
}
