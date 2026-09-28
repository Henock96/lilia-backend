import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DeliveryStatus,
  DriverStatus,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  Prisma,
  Role,
  StatusUser,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UserCacheService } from '../auth/services/user-cache.service';
import { ACTIVE_DELIVERY_STATUSES } from '../deliveries/delivery-statuses';
import { lockDriverRow } from '../drivers/driver-row-lock';
import {
  cancelOpenOffers,
  sweepRevokedOffers,
} from '../drivers/driver-offer-revocation';
import { banPendingIncidentKey } from '../drivers/driver-release';

/**
 * Issue d'une demande de ban (F3-12.1 R7).
 *
 * - `immediate` : `BLOCKED` écrit ; le contrôleur coupe Firebase.
 * - `deferred` : livreur en pleine course — inéligible tout de suite, banni à
 *   la clôture de sa dernière course. Firebase n'est PAS coupé maintenant :
 *   il ne pourrait plus finir la course (décision Q3).
 */
export type BanMode = 'immediate' | 'deferred';

/** Courses qui retiennent un ban : le livreur a accepté, il est en route. */
const HOLDING_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.ACCEPTER,
  DeliveryStatus.EN_TRANSIT,
];

/**
 * Gestion des utilisateurs côté admin (LIL-134) : liste tous rôles, changement
 * de rôle (avec invalidation du cache lu par RolesGuard) et bannissement.
 * Extrait de `AdminService` — API publique inchangée.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private prisma: PrismaService,
    private userCache: UserCacheService,
  ) {}

  /**
   * Liste des comptes, filtrable par rôle, statut et recherche libre.
   *
   * Les filtres `statusUser` et `search` ont été ajoutés en septembre 2026 en
   * même temps que l'écran d'administration qui les consomme : jusque-là,
   * `GET /admin/users` existait mais n'avait aucun appelant, et personne ne
   * pouvait retrouver un compte autrement qu'en paginant.
   */
  async getAllUsers(
    page = 1,
    limit = 20,
    role?: Role,
    statusUser?: StatusUser,
    search?: string,
  ) {
    const where: Prisma.UserWhereInput = {
      ...(role && { role }),
      ...(statusUser && { statusUser }),
      ...(search && {
        OR: [
          { nom: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search } },
        ],
      }),
    };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          imageUrl: true,
          role: true,
          statusUser: true,
          createdAt: true,
          lastLogin: true,
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data: users, total, page, limit };
  }

  /**
   * Fiche d'un compte, avec ce qui le rattache au métier.
   *
   * `restaurant` et `driverProfile` y figurent parce qu'ils conditionnent ce
   * qu'un administrateur a le droit de faire ensuite : on ne retire pas le rôle
   * RESTAURATEUR à quelqu'un qui tient une boutique en ligne sans le savoir.
   */
  async getUserById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        nom: true,
        phone: true,
        imageUrl: true,
        role: true,
        statusUser: true,
        driverStatus: true,
        // F3-12.1 R7 — ban programmé, appliqué à la fin de la course en cours.
        banPendingAt: true,
        banPendingReason: true,
        createdAt: true,
        lastLogin: true,
        restaurant: {
          select: {
            id: true,
            nom: true,
            onboardingStatus: true,
            adminApproved: true,
            isActive: true,
          },
        },
        driverProfile: {
          select: { id: true, isActive: true, vehicleType: true },
        },
        _count: { select: { orders: true, deliveries: true } },
      },
    });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');
    return { data: user };
  }

  /**
   * Change le rôle d'un utilisateur.
   *
   * Trois refus, et chacun décrit une relation métier qu'un simple `UPDATE`
   * romprait **en silence** :
   *
   * 1. rétrogradation d'un ADMIN — règle historique ;
   * 2. retrait du rôle RESTAURATEUR à un propriétaire de boutique.
   *    `Restaurant.ownerId` resterait sur lui, mais `@Roles('RESTAURATEUR')`
   *    le rejetterait : la boutique deviendrait inadministrable tout en restant
   *    `ACTIVATED` et visible des clients. Personne ne pourrait plus la fermer
   *    ni la corriger — sauf à repasser par cette même route, ce que rien
   *    n'indiquerait ;
   * 3. retrait du rôle LIVREUR à quelqu'un qui a une course en cours, ce qui
   *    laisserait une commande sans porteur.
   *
   * Ces refus ne sont pas un garde-fou d'interface : ils vivent ici, donc ils
   * valent aussi pour un appel direct à l'API.
   */
  async updateUserRole(userId: string, dto: UpdateUserRoleDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        restaurant: { select: { id: true, nom: true } },
      },
    });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');

    // Fix F-08 (Master Audit v1) — un administrateur ne se crée plus par
    // l'API. Un seul compte ADMIN compromis pouvait sinon en fabriquer
    // d'autres, qui survivaient à la révocation du premier. La promotion à
    // ADMIN est un geste d'exploitation, hors de l'application (procédure
    // « break-glass » : docs/RUNBOOK_ADMIN.md).
    if (dto.role === 'ADMIN') {
      throw new ForbiddenException(
        "La promotion au rôle ADMIN ne se fait pas depuis l'application. " +
          'Suivez la procédure de création d’administrateur (runbook).',
      );
    }

    if (user.role === dto.role) {
      throw new BadRequestException(`Ce compte est déjà ${dto.role}.`);
    }

    // F3-12.1 (décision Q4) — un livreur se crée par `POST /drivers`, qui pose
    // son profil, son véhicule et sa relation (LILIA / INDEPENDENT). Changer
    // le rôle ici produisait un LIVREUR sans profil, que l'assignation refuse
    // ensuite — ou pire, un profil hérité d'un ancien passage, jamais revu.
    if (dto.role === Role.LIVREUR) {
      throw new ConflictException(
        'Un livreur se crée depuis la fiche Livreurs (profil, véhicule, ' +
          'statut) — pas en changeant le rôle d’un compte existant.',
      );
    }

    // (`dto.role` ne peut plus valoir ADMIN ici : refusé plus haut.)
    if (user.role === 'ADMIN') {
      throw new BadRequestException(
        "Impossible de rétrograder un compte ADMIN via l'API.",
      );
    }

    if (user.role === Role.RESTAURATEUR && user.restaurant) {
      throw new ConflictException(
        `Ce compte est propriétaire de « ${user.restaurant.nom} ». ` +
          'Transférez ou fermez la boutique avant de changer son rôle — sinon ' +
          'elle resterait en ligne sans personne pour la gérer.',
      );
    }

    const updated =
      user.role === Role.LIVREUR
        ? await this.leaveDriverRole(userId, dto.role)
        : await this.prisma.user.update({
            where: { id: userId },
            data: { role: dto.role },
            select: { id: true, email: true, nom: true, role: true },
          });

    // Invalider le cache : le role est lu par RolesGuard à chaque requête.
    await this.invalidateCache(user.firebaseUid);

    this.logger.warn(`Rôle modifié : user ${userId} → ${dto.role}`);
    return { data: updated, message: `Rôle mis à jour : ${dto.role}` };
  }

  /**
   * Quitte le rôle LIVREUR (F3-12.1, gate R6).
   *
   * Tout se décide sous le verrou du livreur, dans l'ordre global
   * R3 (offres) → R4 (User) → R5 (profil). La garde « course en cours » était
   * lue HORS transaction : une acceptation (ou une assignation) commise entre
   * la lecture et l'écriture laissait une course `ACCEPTER` à un compte
   * CLIENT — que `@Roles('LIVREUR')` empêche désormais de faire avancer.
   *
   * Le profil est mis hors service, pas supprimé : si l'admin s'est trompé,
   * recréer le livreur ne lui fait pas ressaisir plaque et permis.
   */
  private async leaveDriverRole(userId: string, role: Role) {
    const updated = await this.prisma.$transaction(async (tx) => {
      await cancelOpenOffers(tx, userId);

      const locked = await lockDriverRow(tx, userId);
      if (!locked) throw new NotFoundException('Utilisateur non trouvé');

      const activeMission = await tx.delivery.findFirst({
        where: {
          delivererId: userId,
          status: { in: ACTIVE_DELIVERY_STATUSES },
        },
        select: { orderId: true, status: true },
      });
      if (activeMission || locked.driverStatus === DriverStatus.ON_DELIVERY) {
        throw new ConflictException(
          `Ce livreur a une course en cours (${activeMission?.status ?? DriverStatus.ON_DELIVERY}` +
            `${activeMission ? `, commande ${activeMission.orderId}` : ''}). ` +
            'Réassignez-la avant de changer son rôle.',
        );
      }

      // CAS sur le rôle : un autre changement de rôle a pu passer pendant
      // qu'on attendait le verrou. Le réécrire en aveugle l'effacerait.
      const claimed = await tx.user.updateMany({
        where: { id: userId, role: Role.LIVREUR },
        data: { role, driverStatus: null },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'Le rôle de ce compte a changé entre-temps. Rechargez sa fiche.',
        );
      }

      await tx.driverProfile.updateMany({
        where: { userId },
        data: { isActive: false, deactivationReason: `Rôle changé en ${role}` },
      });

      return tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, email: true, nom: true, role: true },
      });
    });

    await sweepRevokedOffers(this.prisma, userId);
    return updated;
  }

  /**
   * Bannit un utilisateur (F3-12.1, gate R7).
   *
   * `statusUser = BLOCKED` est ce que lisent `RolesGuard` sur chaque route
   * et `TrackingGateway` sur chaque message ; le contrôleur coupe en plus le
   * compte Firebase et révoque ses jetons, sans quoi le banni se reconnecte.
   *
   * ## Livreur
   *
   * Décidé sous son verrou (R4), après avoir retiré ses offres (R3) :
   *
   * - sans course acceptée : `BLOCKED` + `OFFLINE`. Il ne redevient jamais
   *   candidat sans se redéclarer, même débanni ;
   * - **en pleine course** (`ACCEPTER`/`EN_TRANSIT`) : ban **différé**
   *   (décisions Q3/Q7). Le compte reste `ACTIVE` pour qu'il finisse la
   *   course, mais `banPendingAt` le rend aussitôt inéligible : ni
   *   assignation, ni acceptation, ni offre. `releaseDriverIfIdle` applique
   *   le ban à la clôture de sa dernière course. Un incident signale le cas
   *   à l'exploitation.
   *
   * Une course seulement `ASSIGNER` ne retient pas le ban : il ne l'a pas
   * acceptée, il ne pourra plus le faire, et elle reste à réassigner.
   */
  async banUser(userId: string, reason?: string, adminId?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');
    if (user.role === 'ADMIN')
      throw new BadRequestException('Impossible de bannir un ADMIN.');

    const outcome = await this.prisma.$transaction(async (tx) => {
      await cancelOpenOffers(tx, userId);

      const locked = await lockDriverRow(tx, userId);
      if (!locked) throw new NotFoundException('Utilisateur non trouvé');
      if (locked.statusUser === StatusUser.BLOCKED) {
        throw new ConflictException('Cet utilisateur est déjà banni.');
      }
      if (locked.statusUser !== StatusUser.ACTIVE) {
        throw new ConflictException(
          `Ce compte est ${locked.statusUser} : il n'y a rien à bannir.`,
        );
      }

      const holding = await tx.delivery.findFirst({
        where: { delivererId: userId, status: { in: HOLDING_STATUSES } },
        select: { orderId: true, status: true },
      });
      const waitingAssignments = await tx.delivery.count({
        where: { delivererId: userId, status: DeliveryStatus.ASSIGNER },
      });

      if (holding) {
        if (locked.banPendingAt) {
          throw new ConflictException(
            'Un bannissement est déjà programmé pour ce livreur : il ' +
              "s'appliquera à la fin de sa course en cours.",
          );
        }
        await tx.user.update({
          where: { id: userId },
          data: {
            banPendingAt: new Date(),
            banPendingReason: reason ?? null,
            banPendingById: adminId ?? null,
          },
        });
        // Une demande = un incident ouvert au plus. Pas de course possible
        // sur la clé : elle n'est écrite que sous le verrou de CE livreur.
        const key = banPendingIncidentKey(userId);
        const open = await tx.incident.findFirst({
          where: {
            dedupKey: key,
            status: { in: [IncidentStatus.OPEN, IncidentStatus.IN_PROGRESS] },
          },
          select: { id: true },
        });
        if (!open) {
          await tx.incident.create({
            data: {
              type: IncidentType.OTHER,
              severity: IncidentSeverity.HIGH,
              title: 'Livreur banni pendant une course',
              description:
                'Le bannissement prendra effet à la fin de la course en cours. ' +
                "D'ici là, le livreur ne reçoit plus aucune course.",
              orderId: holding.orderId,
              riderId: userId,
              reportedBy: adminId ?? null,
              dedupKey: key,
            },
          });
        }
        return { mode: 'deferred' as BanMode, waitingAssignments };
      }

      await tx.user.update({
        where: { id: userId },
        data: {
          statusUser: StatusUser.BLOCKED,
          ...(locked.role === Role.LIVREUR && {
            driverStatus: DriverStatus.OFFLINE,
          }),
        },
      });
      return { mode: 'immediate' as BanMode, waitingAssignments };
    });

    await sweepRevokedOffers(this.prisma, userId);

    // Invalider le cache : le statut est lu par RolesGuard à chaque requête et
    // le TTL Redis est de 5 min — sans invalidation le ban traînerait d'autant.
    // Utile aussi en différé : `banPendingAt` n'est pas lu par le garde, mais
    // la fiche en cache ne doit pas mentir.
    const cacheInvalidated = await this.invalidateCache(user.firebaseUid);

    this.logger.warn(
      `User ${userId} banni (${outcome.mode}) — raison : ${reason ?? 'non précisée'}`,
    );

    // Retourne le firebaseUid pour que le controller agisse côté Firebase Auth
    return {
      firebaseUid: user.firebaseUid,
      userId: user.id,
      cacheInvalidated,
      mode: outcome.mode,
      waitingAssignments: outcome.waitingAssignments,
    };
  }

  /**
   * Lève le bannissement — ou annule un ban encore en attente.
   *
   * Un livreur débanni reste `OFFLINE` et perd sa capacité d'offres
   * (`offersEnabledAt = NULL`) : il doit se redéclarer disponible depuis une
   * app à jour. Débanni tel quel, un livreur banni alors qu'il était
   * `AVAILABLE` redevenait candidat à la seconde, sans rien avoir fait.
   *
   * `wasBlocked` dit au contrôleur s'il faut réactiver le compte Firebase :
   * un ban en attente ne l'a jamais coupé.
   */
  async unbanUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');

    const wasBlocked = await this.prisma.$transaction(async (tx) => {
      const locked = await lockDriverRow(tx, userId);
      if (!locked) throw new NotFoundException('Utilisateur non trouvé');

      if (locked.statusUser === StatusUser.ACTIVE && locked.banPendingAt) {
        await tx.user.update({
          where: { id: userId },
          data: {
            banPendingAt: null,
            banPendingReason: null,
            banPendingById: null,
          },
        });
        await tx.incident.updateMany({
          where: {
            dedupKey: banPendingIncidentKey(userId),
            status: { in: [IncidentStatus.OPEN, IncidentStatus.IN_PROGRESS] },
          },
          data: {
            status: IncidentStatus.RESOLVED,
            autoResolved: true,
            resolution: 'Bannissement programmé annulé par un administrateur.',
          },
        });
        return false;
      }

      if (locked.statusUser !== StatusUser.BLOCKED) {
        throw new BadRequestException("Cet utilisateur n'est pas banni.");
      }

      const isDriver = locked.role === Role.LIVREUR;
      await tx.user.update({
        where: { id: userId },
        data: {
          statusUser: StatusUser.ACTIVE,
          ...(isDriver && { driverStatus: DriverStatus.OFFLINE }),
        },
      });
      if (isDriver) {
        await tx.driverProfile.updateMany({
          where: { userId },
          data: { offersEnabledAt: null },
        });
      }
      return true;
    });

    const cacheInvalidated = await this.invalidateCache(user.firebaseUid);

    this.logger.warn(
      `User ${userId} ${wasBlocked ? 'débanni' : 'ban programmé annulé'}`,
    );
    return {
      firebaseUid: user.firebaseUid,
      userId: user.id,
      cacheInvalidated,
      wasBlocked,
    };
  }

  /**
   * Purge le cache user et **remonte l'échec** au lieu de l'avaler.
   *
   * Le ban est déjà écrit en base à ce stade : on ne veut pas faire échouer la
   * requête (ce serait un faux négatif pour l'admin), mais on veut qu'il sache
   * que l'application peut traîner jusqu'à 5 min si Redis est en vrac.
   */
  private async invalidateCache(firebaseUid: string): Promise<boolean> {
    try {
      await this.userCache.invalidateOrThrow(firebaseUid);
      return true;
    } catch (err) {
      this.logger.error(
        `Cache user non invalidé pour ${firebaseUid} — le changement de statut ` +
          `mettra jusqu'à 5 min à s'appliquer : ${(err as Error).message}`,
      );
      return false;
    }
  }
}
