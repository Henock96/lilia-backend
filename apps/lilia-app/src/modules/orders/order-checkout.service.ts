import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  LocationPrecision,
  LoyaltyTransactionType,
  Prisma,
} from '@prisma/client';
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
import {
  DeliveryDestinationService,
  ResolvedDestination,
} from './delivery-destination.service';
import { OrderTransitionService } from './order-transition.service';
import { DeliveryPricingService } from '../delivery-pricing/delivery-pricing.service';
import { DeliveryQuote } from '../delivery-pricing/delivery-pricing.engine';

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
    private readonly destinationService: DeliveryDestinationService,
    // F3-02 : prix de base plateforme et part offerte par le vendeur.
    private readonly deliveryPricing: DeliveryPricingService,
    // P0-4 : ouvre l'historique de la commande dans la transaction de création.
    private readonly transitions: OrderTransitionService,
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

    // 1. Résoudre la destination de livraison (seulement si c'est une livraison)
    //
    // ⚠️ `deliveryLatitude` / `deliveryLongitude` du DTO ne sont **pas**
    // utilisés ici. Ils portent la position du téléphone du client, pas celle
    // de l'adresse qu'il a choisie ; les recopier envoyait le livreur là où le
    // client se trouvait au moment de payer. Ils ne servent plus qu'à mesurer
    // l'écart, pour l'observabilité.
    let destination: ResolvedDestination | null = null;

    if (isDelivery) {
      if (!adresseId) {
        this.logger.warn(
          `📦 [COMMANDE] Échec: adresse manquante pour livraison - user: ${user.id}`,
        );
        throw new BadRequestException(
          'Une adresse de livraison est requise pour la livraison à domicile.',
        );
      }
      destination = await this.destinationService.resolveForAddress(
        adresseId,
        user.id,
        { latitude: deliveryLatitude, longitude: deliveryLongitude },
      );
    } else {
      this.logger.log(`📦 [COMMANDE] Mode retrait au restaurant`);
    }
    const deliveryAddress = destination?.address ?? null;
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
    //
    // Le quartier vient désormais de la destination déjà résolue : c'est la
    // même lecture d'adresse qui sert au calcul des frais et à la position du
    // livreur, donc les deux ne peuvent plus diverger — et une requête
    // Prisma de moins.
    //
    // F3-02 — en mode PLATFORM, ni le prix fixe ni la zone du vendeur ne sont
    // lus (R-02.9) : la plateforme fixe le prix de base plus bas.
    const settings = await this.platformSettings.getSettings();
    const platformPricing = settings.deliveryPricingMode === 'PLATFORM';
    let effectiveDeliveryFee = restaurant.fixedDeliveryFee;
    const deliveryQuartierId = isDelivery
      ? (destination?.quartierId ?? null)
      : null;
    if (
      isDelivery &&
      !platformPricing &&
      restaurant.deliveryPriceMode === 'ZONE_BASED' &&
      deliveryQuartierId
    ) {
      const zoneFee = await this.quartiersService.calculateDeliveryFee(
        restaurantId,
        deliveryQuartierId,
      );
      effectiveDeliveryFee = zoneFee.fee;
    }

    // Le taux du vendeur est lu maintenant et figé sur la commande : le
    // modifier ensuite ne doit pas réécrire ce que la plateforme a prélevé
    // sur des commandes déjà passées.
    //
    // ⚠️ C'est le SEUL endroit du système qui résout « quel taux ? ». Le
    // repli « vendeur sinon plateforme » vivait aussi dans
    // `RestaurantPayoutService`, avec une valeur différente (`0` ici, taux
    // plateforme là-bas) : les 124 commandes de production portaient donc
    // `commissionPercent = 0` pendant que les reversements prélevaient 10 %.
    // Le reversement lit désormais ce snapshot et ne résout plus rien.
    //
    // `??` et non `||` : un vendeur à 0 % a bien un taux, et il vaut 0.
    const commissionPercent =
      restaurant.commissionPercent ?? settings.restaurantCommissionPercent;

    // 2. Calcul — isolé, testable unitairement
    let amounts = this.calculator.calculate(
      cartItems,
      effectiveDeliveryFee,
      isDelivery,
      settings.serviceFeePercent,
      commissionPercent,
    );

    // F3-02 — devis plateforme. Il lui faut le sous-total (seuil « livraison
    // offerte dès X »), d'où un second calcul avec le prix client ; le
    // calculateur est pur et le sous-total ne dépend pas des frais.
    let deliveryQuote: DeliveryQuote | null = null;
    if (isDelivery && platformPricing) {
      deliveryQuote = await this.deliveryPricing.quoteForVendor({
        vendor: restaurant,
        destination: {
          quartierId: deliveryQuartierId,
          latitude: destination?.latitude ?? null,
          longitude: destination?.longitude ?? null,
        },
        subTotalXaf: amounts.subTotal,
      });
      if (deliveryQuote) {
        if (deliveryQuote.basis === 'FALLBACK') {
          this.logger.warn(
            `📦 [COMMANDE] Tarif de repli (position inconnue) — vendeur ${restaurantId}, quartier ${deliveryQuartierId ?? 'aucun'}`,
          );
        }
        amounts = this.calculator.calculate(
          cartItems,
          deliveryQuote.customerFeeXaf,
          isDelivery,
          settings.serviceFeePercent,
          commissionPercent,
        );
      }
    }
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

    // Réduction points de fidélité — plafonnée au **panier alimentaire**.
    //
    // ⚠️ L'assiette a changé en septembre 2026. Les points s'imputaient sur
    // `subTotal + deliveryFee + serviceFee` : ils finançaient donc la course du
    // livreur et les frais de fonctionnement, deux postes réellement décaissés
    // et que le reversement vendeur ne compense pas (il se calcule sur
    // `subTotal` brut). Une commande réglée intégralement en points ne rentrait
    // aucun franc tout en devant payer le livreur.
    //
    // Les points ne réduisent désormais que ce que le client achète à manger,
    // déduction faite de la promo déjà appliquée sur ce même panier. La
    // livraison et les frais de service restent dus en argent.
    //
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
        // Assiette : le panier alimentaire, une fois la promo passée dessus.
        // `discountAmount` d'un code FREE_DELIVERY vaut 0 (sa remise porte sur
        // `finalDeliveryFee`), il ne rogne donc pas cette assiette — ce qui est
        // exact : il n'a rien offert sur la nourriture.
        const redeemableBase = Math.max(0, amounts.subTotal - discountAmount);
        // Nombre de points effectivement utilisables (entier, plafonné au solde
        // ET à l'assiette)
        loyaltyPointsUsed = Math.min(
          pts,
          Math.floor(redeemableBase / settings.loyaltyPointValueXaf),
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
      // ⚠️ Fix F-11 — un panier ne se paie qu'une fois, et c'est la BASE qui
      // l'arbitre, pas Redis.
      //
      // Le panier est lu plus haut, hors transaction. Deux checkouts portant
      // deux clés d'idempotence différentes (app + web, deux onglets, ou Redis
      // indisponible — l'idempotence se dégrade alors en best-effort) lisaient
      // le même panier et créaient deux commandes : le stock limité en
      // bloquait une, un stock illimité (`null`, le cas courant) aucune.
      //
      // Le verrou de ligne sur `Cart` sérialise les checkouts d'un même
      // client ; le panier est ensuite relu SOUS verrou et comparé à
      // l'instantané qui a servi aux calculs. Le second checkout, débloqué
      // après le commit du premier, trouve un panier vide ou différent et
      // échoue en 409 — sa transaction entière (commande, stock, points,
      // promo) est annulée.
      await this.lockCartAndAssertUnchanged(tx, user.cart!.id, cartItems);

      const newOrder = await tx.order.create({
        data: {
          userId: user.id,
          restaurantId,
          subTotal: amounts.subTotal,
          deliveryFee: finalDeliveryFee,
          // Tarif AVANT remise commerciale — l'assiette qui rémunère le
          // livreur. `finalDeliveryFee` ci-dessus est le montant après promo :
          // un code FREE_DELIVERY le met à 0, et payer la course dessus ferait
          // porter au livreur une campagne qu'il n'a pas décidée. C'est la
          // règle déjà posée pour le vendeur, dont le reversement ignore les
          // remises ; elle vaut des deux côtés de la course.
          //
          // F3-02 : en mode PLATFORM, c'est le prix de BASE de la grille, et
          // non le prix client — la part offerte par le vendeur ne doit pas
          // réduire la paie du livreur (décision D3 : % de la base).
          deliveryFeeGross: deliveryQuote?.baseFeeXaf ?? amounts.deliveryFee,
          deliveryTariffVersion: deliveryQuote?.tariffVersion ?? null,
          deliveryDistanceKm: deliveryQuote?.distanceKm ?? null,
          deliveryFeeBaseXaf: deliveryQuote?.baseFeeXaf ?? null,
          vendorDeliverySubsidyXaf: deliveryQuote?.subsidyXaf ?? 0,
          serviceFee: amounts.serviceFee,
          commissionPercent: amounts.commissionPercent,
          commissionAmount: amounts.commissionAmount,
          discountAmount: discountAmount + loyaltyDiscount,
          // Part « fidélité » isolée, figée à la commande. `discountAmount`
          // reste la remise totale (promo + fidélité) : c'est lui qui entre
          // dans `total`, et le reversement vendeur comme les remboursements
          // continuent de le lire sans changement.
          loyaltyPointsUsed,
          loyaltyDiscount,
          total: finalTotal,
          promoCodeId: promoResult?.promoCodeId ?? null,
          isDelivery,
          notes,
          contactPhone,
          // Snapshot de la destination : figé ici, jamais recalculé. Le client
          // peut corriger son adresse demain, cette commande continuera de
          // pointer là où elle a été livrée.
          deliveryAddress,
          deliveryLatitude: destination?.latitude ?? null,
          deliveryLongitude: destination?.longitude ?? null,
          deliveryPrecision:
            destination?.precision ?? LocationPrecision.UNKNOWN,
          deliveryLandmark: destination?.landmark ?? null,
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

      // Ouvre l'historique de la commande (P0-4), dans LA transaction de
      // création : une commande ne peut pas exister sans sa première ligne.
      //
      // `fromStatus` vaut `null` — il n'y a pas d'état quitté. L'écrire
      // `EN_ATTENTE → EN_ATTENTE` ferait compter la création comme une
      // transition dans les agrégations de durée par étape, c'est-à-dire
      // fausserait exactement la mesure pour laquelle cette table existe.
      await this.transitions.recordCreation(tx, {
        orderId: newOrder.id,
        to: 'EN_ATTENTE',
        actor: 'CLIENT',
        actorUserId: user.id,
        source: 'APP',
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
      // On ne vide QUE les lignes commandées : une ligne ajoutée depuis un
      // autre appareil pendant ce checkout n'a pas été facturée et ne doit pas
      // disparaître avec les autres.
      await tx.cartItem.deleteMany({
        where: {
          cartId: user.cart!.id,
          id: { in: cartItems.map((item) => item.id) },
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
  /**
   * Verrouille le panier (`SELECT … FOR UPDATE`) et vérifie que son contenu est
   * exactement celui sur lequel la commande a été calculée — mêmes lignes,
   * mêmes quantités. Sinon 409 : le client a commandé ailleurs entre-temps,
   * ou modifié son panier pendant la validation.
   */
  private async lockCartAndAssertUnchanged(
    tx: Prisma.TransactionClient,
    cartId: string,
    snapshot: { id: string; quantite: number }[],
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${cartId} FOR UPDATE`;
    const current = await tx.cartItem.findMany({
      where: { cartId },
      select: { id: true, quantite: true },
    });
    const expected = new Map(snapshot.map((line) => [line.id, line.quantite]));
    const unchanged =
      current.length === expected.size &&
      current.every((line) => expected.get(line.id) === line.quantite);
    if (!unchanged) {
      this.logger.warn(
        `📦 [COMMANDE] Panier ${cartId} modifié ou déjà commandé pendant la validation — checkout refusé`,
      );
      throw new ConflictException(
        current.length === 0
          ? 'Ce panier vient déjà d’être commandé. Consultez « Mes commandes ».'
          : 'Votre panier a changé pendant la validation. Vérifiez-le puis recommencez.',
      );
    }
  }

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
