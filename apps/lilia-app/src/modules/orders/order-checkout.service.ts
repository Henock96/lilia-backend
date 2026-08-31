import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LoyaltyTransactionType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Sentry from '@sentry/nestjs';
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
    // Fix H8 : l'en-tête est désormais OBLIGATOIRE. Le mécanisme `SET NX`
    // était correct mais ne s'activait que si le client l'envoyait — un client
    // qui l'omettait (ou un attaquant) retrouvait le comportement d'avant le
    // correctif : double-tap ⇒ deux commandes, deux décréments de stock, deux
    // notifications. Les trois clients (Flutter ×2 + web) l'envoient déjà.
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException(
        "En-tête 'Idempotency-Key' requis pour créer une commande.",
      );
    }
    if (key.length > 128) {
      throw new BadRequestException("En-tête 'Idempotency-Key' trop long.");
    }

    const cacheKey = this.idempotencyEnabled
      ? `idempotency:${firebaseUid}:${key}`
      : null;

    if (!cacheKey) {
      // Redis non configuré : on n'a pas de garde possible. On le signale
      // bruyamment plutôt que de le laisser passer en silence — sans quoi une
      // panne d'infrastructure devient une faille métier invisible.
      this.logger.error(
        '⚠️ [IDEMPOTENCY] Redis indisponible — checkout NON protégé contre les doublons',
      );
      Sentry.captureMessage(
        "Checkout sans garde d'idempotence (Redis indisponible)",
        'warning',
      );
      return this.performCheckout(firebaseUid, dto);
    }

    const claim = await this.claimIdempotencyKey(cacheKey, key);
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
      // Le taux du vendeur est lu maintenant et figé sur la commande : le
      // modifier ensuite ne doit pas réécrire ce que la plateforme a prélevé
      // sur des commandes déjà passées.
      restaurant.commissionPercent,
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
    const { order } = await this.prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          userId: user.id,
          restaurantId,
          subTotal: amounts.subTotal,
          deliveryFee: finalDeliveryFee,
          serviceFee: amounts.serviceFee,
          commissionPercent: amounts.commissionPercent,
          commissionAmount: amounts.commissionAmount,
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
        // Fix L7 : sur un code FREE_DELIVERY, `discountAmount` vaut 0 (la
        // remise porte sur les frais, pas sur le sous-total) et
        // `PromoUsage.discountApplied` enregistrait donc 0 — les statistiques
        // de campagne sous-estimaient le coût réel. On trace ce que la
        // plateforme a effectivement offert.
        const deliveryDiscount = Math.max(
          0,
          amounts.deliveryFee - finalDeliveryFee,
        );
        await this.promoService.applyCode(
          tx,
          promoResult.promoCodeId,
          user.id,
          newOrder.id,
          discountAmount + deliveryDiscount,
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
            type: LoyaltyTransactionType.ORDER_SPEND,
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

      // ⚠️ L'obligation de notifier le VENDEUR n'est plus écrite ici (chantier
      // pawaPay, août 2026).
      //
      // Elle l'était à la création de la commande, donc avant tout paiement.
      // Le fix H7 reste entier — l'obligation est toujours écrite DANS une
      // transaction, mais dans celle qui confirme le paiement
      // (`PaymentService.confirmCollection`, type `order.paid`). Le principe est
      // le même, le moment est juste : une commande non payée n'a pas à
      // déranger un vendeur, et avec un prestataire qui tranche en une minute,
      // notifier plus tôt reviendrait à le prévenir de commandes abandonnées.
      return { order: newOrder };
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

    // ⚠️ La récompense de parrainage N'EST PLUS versée ici (fix C3, audit du
    // 28/08/2026) : elle l'était à la création de la commande, donc sans aucun
    // paiement. Elle est désormais déclenchée par `order.payment.confirmed`
    // → PaymentListener → ReferralService.rewardIfFirstPaidOrder().

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
      // Dégradation volontaire : une panne Redis ne doit pas fermer la caisse.
      // Mais elle désactive une garde de sécurité, donc elle remonte en alerte
      // (fix H8) au lieu de rester une ligne de log parmi d'autres.
      this.logger.error(
        `Redis (idempotence checkout) indisponible — checkout non protégé : ${
          (err as Error).message
        }`,
      );
      Sentry.captureException(err, {
        tags: { feature: 'checkout-idempotency', degraded: 'true' },
      });
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
}
