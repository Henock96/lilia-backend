import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from '../firebase/firebase.service';
import { UserCacheService } from '../auth/services/user-cache.service';

/**
 * Suppression de compte à l'initiative de l'utilisateur (`DELETE /users/me`).
 *
 * **Anonymisation, pas DELETE.** La ligne `User` est conservée, vidée de toute
 * donnée personnelle et marquée `statusUser = DELETED`. Deux raisons :
 *
 * 1. Depuis `20260827120000_enable_foreign_keys`, `Order`, `Payment`,
 *    `Delivery` et `PromoUsage` portent une vraie FK vers `User` en `RESTRICT`.
 *    Un `prisma.user.delete()` lèverait un P2003 dès la première commande.
 * 2. Même en ajoutant des cascades, il ne *faut* pas effacer une commande
 *    livrée et encaissée : elle porte du chiffre d'affaires, alimente les
 *    dashboards vendeur et les stats plateforme. On coupe le lien à l'identité,
 *    on garde la pièce comptable.
 *
 * Ce qui disparaît réellement : adresses, tokens FCM, panier, favoris, avis,
 * historique de fidélité. Ce qui survit, désormais anonyme : commandes, items,
 * paiements, livraisons, usages de codes promo.
 */
@Injectable()
export class UserDeletionService {
  private readonly logger = new Logger(UserDeletionService.name);

  /** Statuts non terminaux : une commande en vol interdit la suppression. */
  private static readonly ACTIVE_ORDER_STATUSES: OrderStatus[] = [
    'EN_ATTENTE',
    'PAYER',
    'EN_PREPARATION',
    'PRET',
    'EN_ROUTE',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseService,
    private readonly userCache: UserCacheService,
  ) {}

  /**
   * Anonymise le compte, purge les données personnelles, puis supprime le
   * compte Firebase Auth.
   *
   * Idempotent : rappeler la route sur un compte déjà `DELETED` renvoie le même
   * succès sans retoucher la base (le client mobile retente en cas de réseau
   * coupé, et son token peut encore être valide quelques minutes).
   */
  async deleteOwnAccount(
    userId: string,
  ): Promise<{ message: string; warning?: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');

    if (user.statusUser === 'DELETED') {
      return { message: 'Ce compte a déjà été supprimé.' };
    }

    await this.assertDeletable(user);

    const firebaseUid = user.firebaseUid;

    await this.prisma.$transaction(async (tx) => {
      // Purge — ordre sans importance, aucune de ces tables n'est parente
      // d'une autre sauf Cart → CartItem (cascade PostgreSQL depuis Ar1).
      await tx.adresses.deleteMany({ where: { userId } });
      await tx.fcmToken.deleteMany({ where: { userId } });
      await tx.cart.deleteMany({ where: { userId } });
      await tx.favorite.deleteMany({ where: { userId } });
      await tx.review.deleteMany({ where: { userId } });
      await tx.loyaltyTransaction.deleteMany({ where: { userId } });

      await tx.user.update({
        where: { id: userId },
        data: this.anonymizedFields(userId),
      });
    });

    // Hors transaction : Firebase et Redis ne sont pas rollbackables, et on ne
    // veut pas tenir une transaction PostgreSQL ouverte pendant un appel réseau.
    await this.firebase.deleteUserSafe(firebaseUid);

    // Le cache Redis sert le User pendant 5 min : sans invalidation, le token
    // encore valide continuerait de passer les guards avec l'ancien statut.
    // L'échec doit être visible — c'est une fenêtre d'accès à un compte supprimé.
    let warning: string | undefined;
    try {
      await this.userCache.invalidateOrThrow(firebaseUid);
    } catch (err) {
      warning =
        'Compte supprimé, mais le cache de session n’a pas pu être vidé : ' +
        'l’accès peut persister jusqu’à 5 minutes.';
      this.logger.error(
        `Invalidation cache échouée pour ${firebaseUid} : ${(err as Error).message}`,
      );
    }

    this.logger.warn(`Compte supprimé (anonymisé) : ${userId}`);
    return {
      message: 'Votre compte a été supprimé.',
      ...(warning ? { warning } : {}),
    };
  }

  /**
   * Les trois cas où la suppression est refusée (409). Chacun laisserait
   * derrière lui une transaction en cours sans interlocuteur.
   */
  private async assertDeletable(user: User): Promise<void> {
    const [activeOrders, ownedVendor, activeMissions] = await Promise.all([
      this.prisma.order.count({
        where: {
          userId: user.id,
          status: { in: UserDeletionService.ACTIVE_ORDER_STATUSES },
        },
      }),
      this.prisma.restaurant.findFirst({
        where: { ownerId: user.id },
        select: { id: true, nom: true },
      }),
      this.prisma.delivery.count({
        where: {
          delivererId: user.id,
          status: { in: ['ASSIGNER', 'EN_TRANSIT'] },
        },
      }),
    ]);

    if (activeOrders > 0) {
      throw new ConflictException(
        `Vous avez ${activeOrders} commande(s) en cours. ` +
          'Attendez leur livraison ou annulez-les avant de supprimer votre compte.',
      );
    }

    if (ownedVendor) {
      throw new ConflictException(
        `Votre compte gère le vendeur « ${ownedVendor.nom} ». ` +
          'Contactez le support Lilia Food pour transférer ou fermer la boutique ' +
          'avant de supprimer votre compte.',
      );
    }

    if (activeMissions > 0 || user.driverStatus === 'ON_DELIVERY') {
      throw new ConflictException(
        'Vous avez une livraison en cours. ' +
          'Terminez-la avant de supprimer votre compte.',
      );
    }
  }

  /**
   * `email` et `firebaseUid` sont `@unique` : on ne peut pas les mettre à
   * `null`, on les remplace par une valeur dérivée de l'`id` (donc unique) qui
   * ne porte aucune information personnelle. Libérer le `firebaseUid` permet
   * en outre à la personne de se réinscrire plus tard avec la même adresse
   * Google/e-mail : `POST /users/sync` créera un compte neuf au lieu de
   * ressusciter celui-ci.
   */
  private anonymizedFields(userId: string): Prisma.UserUpdateInput {
    return {
      firebaseUid: `deleted-${userId}`,
      email: `deleted-${userId}@deleted.liliafood.com`,
      nom: null,
      phone: null,
      imageUrl: null,
      lastLogin: null,
      statusUser: 'DELETED',
      driverStatus: null,
      // Le code de parrainage est libéré : il ne doit plus créditer un compte
      // mort. Les `referredByCode` qui le citaient encore pointent dans le vide,
      // ce que le parrainage tolère déjà (référence par string, sans FK).
      referralCode: null,
      referredByCode: null,
      loyaltyPoints: 0,
      welcomeEmailSentAt: null,
      welcomeSmsSentAt: null,
    };
  }
}
