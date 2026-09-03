import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  DeliveryStatus,
  Prisma,
  Role,
  StatusUser,
  VehicleType,
} from '@prisma/client';
import { randomBytes } from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from '../firebase/firebase.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { UserCacheService } from '../auth/services/user-cache.service';
import { PaginationService } from '../../common/pagination/pagination.service';
import {
  CreateDriverDto,
  DeactivateDriverDto,
  DriverFilterDto,
  UpdateDriverDto,
  UpdateMyDriverProfileDto,
} from './dto/driver.dto';

/** Courses qui occupent réellement un livreur. */
const ACTIVE_DELIVERY_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.ASSIGNER,
  DeliveryStatus.ACCEPTER,
  DeliveryStatus.EN_TRANSIT,
];

/**
 * Projection commune aux vues d'administration.
 *
 * Les trois statuts y figurent **côte à côte et nommés distinctement**. C'est
 * délibéré : les fusionner en un seul « statut » dans la réponse obligerait
 * chaque front à réinventer la règle de fusion, et deux fronts la réinventent
 * différemment.
 */
const DRIVER_ADMIN_SELECT = {
  id: true,
  nom: true,
  email: true,
  phone: true,
  imageUrl: true,
  statusUser: true,
  driverStatus: true,
  lastLogin: true,
  createdAt: true,
  driverProfile: {
    select: {
      id: true,
      vehicleType: true,
      plateNumber: true,
      licenseNumber: true,
      licenseExpiry: true,
      isActive: true,
      activatedAt: true,
      activatedById: true,
      deactivationReason: true,
      zones: { select: { id: true, nom: true, ville: true } },
    },
  },
} satisfies Prisma.UserSelect;

@Injectable()
export class DriversService {
  private readonly logger = new Logger(DriversService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseService,
    private readonly audit: AdminAuditService,
    private readonly userCache: UserCacheService,
    private readonly pagination: PaginationService,
  ) {}

  // ─── Création ──────────────────────────────────────────────────────────────

  /**
   * Crée le compte livreur et son profil métier, de façon atomique.
   *
   * Calqué sur `VendorOnboardingService.doCreateVendor`, et pour les mêmes
   * raisons : le compte Firebase naît avec un secret jetable que personne ne
   * voit, et le livreur définit le sien via un lien signé. L'administrateur ne
   * transmet jamais de mot de passe par un canal qu'il ne maîtrise pas.
   *
   * Le profil naît `isActive = false` : créer un livreur et l'autoriser à
   * prendre des courses sont deux décisions, et la seconde suppose d'avoir vu
   * ses papiers.
   */
  async createDriver(dto: CreateDriverDto, adminId: string) {
    const email = dto.email.trim().toLowerCase();

    // Contrôle préalable pour un message utile. La garantie reste
    // `User.email @unique` : entre ce SELECT et l'INSERT, un autre admin peut
    // créer le même compte.
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true },
    });
    if (existing) {
      throw new ConflictException(
        existing.role === Role.LIVREUR
          ? `${email} est déjà livreur sur la plateforme.`
          : `${email} a déjà un compte ${existing.role}. Changez son rôle depuis la fiche utilisateur plutôt que de créer un doublon.`,
      );
    }

    this.assertPlateConsistency(dto.vehicleType, dto.plateNumber);
    await this.assertZonesExist(dto.zoneIds);

    // Jamais journalisé, jamais retourné, jamais connu de personne. Il n'existe
    // que parce que l'API Firebase exige un secret à la création.
    const throwawayPassword = randomBytes(32).toString('base64url');

    let firebaseUid: string;
    try {
      firebaseUid = await this.firebase.createUser({
        email,
        password: throwawayPassword,
        displayName: dto.nom,
      });
    } catch (err: unknown) {
      throw this.mapFirebaseCreateError(err, email);
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            firebaseUid,
            email,
            nom: dto.nom,
            phone: dto.phone,
            imageUrl: dto.imageUrl ?? null,
            role: Role.LIVREUR,
            // Pas de disponibilité tant qu'il ne s'est pas déclaré. `OFFLINE`
            // plutôt que `null` : `null` signifie « on ne sait pas », et on
            // sait — il n'a jamais ouvert l'application.
            driverStatus: 'OFFLINE',
          },
        });

        await tx.driverProfile.create({
          data: {
            userId: user.id,
            vehicleType: dto.vehicleType,
            plateNumber: dto.plateNumber ?? null,
            licenseNumber: dto.licenseNumber ?? null,
            licenseExpiry: dto.licenseExpiry
              ? new Date(dto.licenseExpiry)
              : null,
            isActive: false,
            ...(dto.zoneIds?.length && {
              zones: { connect: dto.zoneIds.map((id) => ({ id })) },
            }),
          },
        });

        return user;
      });

      await this.audit.record({
        actorId: adminId,
        action: AdminAuditAction.DRIVER_CREATED,
        targetType: 'User',
        targetId: created.id,
        metadata: { email, vehicleType: dto.vehicleType },
      });

      this.logger.log(`Livreur créé : ${dto.nom} (${created.id})`);

      const driver = await this.findOne(created.id);
      return {
        data: driver.data,
        message: `${dto.nom} a été créé. Activez son profil une fois ses documents vérifiés.`,
      };
    } catch (err) {
      // La transaction a échoué : le compte Firebase n'a plus de contrepartie
      // en base. Sans cette suppression, l'adresse resterait réservée et toute
      // nouvelle tentative échouerait en « e-mail déjà utilisé », sans que rien
      // n'indique pourquoi.
      await this.rollbackFirebaseUser(firebaseUid, email);
      throw err;
    }
  }

  // ─── Lecture ───────────────────────────────────────────────────────────────

  async findAll(filter: DriverFilterDto, page = 1, limit = 20) {
    const where: Prisma.UserWhereInput = {
      role: Role.LIVREUR,
      ...(filter.statusUser && { statusUser: filter.statusUser as StatusUser }),
      ...(filter.driverStatus && { driverStatus: filter.driverStatus }),
      ...(filter.isActive !== undefined && {
        driverProfile: { isActive: filter.isActive },
      }),
      ...(filter.search && {
        OR: [
          { nom: { contains: filter.search, mode: 'insensitive' as const } },
          { email: { contains: filter.search, mode: 'insensitive' as const } },
          { phone: { contains: filter.search } },
        ],
      }),
    };

    const [drivers, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          ...DRIVER_ADMIN_SELECT,
          _count: {
            select: {
              deliveries: {
                where: { status: { in: ACTIVE_DELIVERY_STATUSES } },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: drivers,
      meta: this.pagination.getPaginationMeta(page, limit, total),
    };
  }

  async findOne(userId: string) {
    const driver = await this.prisma.user.findUnique({
      where: { id: userId },
      select: DRIVER_ADMIN_SELECT,
    });
    if (!driver || !(await this.isDriver(userId))) {
      throw new NotFoundException('Livreur introuvable.');
    }

    const [activeDeliveries, lastDelivery, ratings] = await Promise.all([
      this.prisma.delivery.findMany({
        where: {
          delivererId: userId,
          status: { in: ACTIVE_DELIVERY_STATUSES },
        },
        select: {
          id: true,
          orderId: true,
          status: true,
          acceptedAt: true,
          pickedUpAt: true,
          order: { select: { restaurant: { select: { nom: true } } } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.delivery.findFirst({
        where: { delivererId: userId, deliveredAt: { not: null } },
        orderBy: { deliveredAt: 'desc' },
        select: { deliveredAt: true },
      }),
      this.prisma.deliveryReview.aggregate({
        where: { delivererId: userId },
        _avg: { rating: true },
        _count: { _all: true },
      }),
    ]);

    return {
      data: {
        ...driver,
        activity: {
          activeDeliveries,
          lastDeliveryAt: lastDelivery?.deliveredAt ?? null,
          averageRating: ratings._avg.rating,
          totalRatings: ratings._count._all,
        },
      },
    };
  }

  /**
   * Vue du livreur sur lui-même.
   *
   * Renvoie les trois statuts séparément — c'est ce qui permet à l'application
   * d'afficher « compte actif, profil actif, hors ligne » au lieu du « Statut
   * compte : Actif » écrit en dur qu'elle affichait, y compris pour un compte
   * suspendu.
   */
  async findMe(userId: string) {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nom: true,
        email: true,
        phone: true,
        imageUrl: true,
        role: true,
        statusUser: true,
        driverStatus: true,
        driverProfile: {
          select: {
            vehicleType: true,
            plateNumber: true,
            licenseNumber: true,
            licenseExpiry: true,
            isActive: true,
            activatedAt: true,
            zones: { select: { id: true, nom: true } },
          },
        },
      },
    });
    if (!me) throw new NotFoundException('Compte introuvable.');
    return { data: me };
  }

  async updateMe(userId: string, dto: UpdateMyDriverProfileDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.nom !== undefined && { nom: dto.nom }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl }),
      },
      select: { firebaseUid: true },
    });
    await this.userCache.invalidate(user.firebaseUid);
    return { ...(await this.findMe(userId)), message: 'Profil mis à jour.' };
  }

  // ─── Écriture (admin) ──────────────────────────────────────────────────────

  async updateDriver(userId: string, dto: UpdateDriverDto, adminId: string) {
    const current = await this.getProfileOrThrow(userId);

    const vehicleType = dto.vehicleType ?? current.vehicleType;
    const plateNumber =
      dto.plateNumber !== undefined ? dto.plateNumber : current.plateNumber;
    this.assertPlateConsistency(vehicleType, plateNumber);
    await this.assertZonesExist(dto.zoneIds);

    const userData: Prisma.UserUpdateInput = {};
    if (dto.nom !== undefined) userData.nom = dto.nom;
    if (dto.phone !== undefined) userData.phone = dto.phone;
    if (dto.imageUrl !== undefined) userData.imageUrl = dto.imageUrl;

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(userData).length > 0) {
        await tx.user.update({ where: { id: userId }, data: userData });
      }
      await tx.driverProfile.update({
        where: { userId },
        data: {
          ...(dto.vehicleType !== undefined && {
            vehicleType: dto.vehicleType,
          }),
          ...(dto.plateNumber !== undefined && {
            plateNumber: dto.plateNumber ?? null,
          }),
          ...(dto.licenseNumber !== undefined && {
            licenseNumber: dto.licenseNumber ?? null,
          }),
          ...(dto.licenseExpiry !== undefined && {
            licenseExpiry: dto.licenseExpiry
              ? new Date(dto.licenseExpiry)
              : null,
          }),
          // `set` et non `connect` : la liste envoyée par le formulaire est la
          // liste voulue. Avec `connect`, retirer une zone serait impossible.
          ...(dto.zoneIds !== undefined && {
            zones: { set: dto.zoneIds.map((id) => ({ id })) },
          }),
        },
      });
    });

    const fresh = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { firebaseUid: true },
    });
    await this.userCache.invalidate(fresh.firebaseUid);

    await this.audit.record({
      actorId: adminId,
      action: AdminAuditAction.DRIVER_UPDATED,
      targetType: 'User',
      targetId: userId,
      metadata: { vehicleType, zones: dto.zoneIds?.length ?? null },
    });

    return { ...(await this.findOne(userId)), message: 'Livreur mis à jour.' };
  }

  /** Met le livreur en service. Réservé à l'ADMIN. */
  async activate(userId: string, adminId: string) {
    const profile = await this.getProfileOrThrow(userId);
    if (profile.isActive) {
      throw new ConflictException('Ce livreur est déjà actif.');
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { statusUser: true, firebaseUid: true },
    });
    // Activer le profil d'un compte suspendu produirait un livreur « actif »
    // que `RolesGuard` rejette à chaque requête — un état qui ne veut rien dire.
    if (user.statusUser !== StatusUser.ACTIVE) {
      throw new ConflictException(
        `Le compte de ce livreur est ${user.statusUser}. Levez d'abord la suspension.`,
      );
    }

    await this.prisma.driverProfile.update({
      where: { userId },
      data: {
        isActive: true,
        activatedAt: new Date(),
        activatedById: adminId,
        deactivationReason: null,
      },
    });

    await this.audit.record({
      actorId: adminId,
      action: AdminAuditAction.DRIVER_ACTIVATED,
      targetType: 'User',
      targetId: userId,
    });

    this.logger.log(`Livreur ${userId} activé par ${adminId}`);
    return { ...(await this.findOne(userId)), message: 'Livreur activé.' };
  }

  /**
   * Retire le livreur de la file d'assignation.
   *
   * Refusé s'il a une course en cours : le retirer laisserait une commande sans
   * porteur, et l'arbitrage (réassigner ou annuler) appartient au vendeur.
   */
  async deactivate(userId: string, dto: DeactivateDriverDto, adminId: string) {
    const profile = await this.getProfileOrThrow(userId);
    if (!profile.isActive) {
      throw new ConflictException("Ce livreur n'est pas actif.");
    }

    const busy = await this.prisma.delivery.findFirst({
      where: { delivererId: userId, status: { in: ACTIVE_DELIVERY_STATUSES } },
      select: { id: true, orderId: true, status: true },
    });
    if (busy) {
      throw new ConflictException(
        `Ce livreur a une course en cours (${busy.status}, commande ${busy.orderId}). ` +
          'Réassignez-la ou attendez sa clôture avant de le désactiver.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.driverProfile.update({
        where: { userId },
        data: { isActive: false, deactivationReason: dto.reason ?? null },
      }),
      // Il ne doit plus apparaître comme disponible : la liste d'assignation
      // lit `driverStatus`, et un livreur désactivé mais « AVAILABLE » y
      // resterait affiché jusqu'à ce qu'il ouvre l'application.
      this.prisma.user.update({
        where: { id: userId },
        data: { driverStatus: 'OFFLINE' },
      }),
    ]);

    await this.audit.record({
      actorId: adminId,
      action: AdminAuditAction.DRIVER_DEACTIVATED,
      targetType: 'User',
      targetId: userId,
      reason: dto.reason,
    });

    this.logger.warn(`Livreur ${userId} désactivé par ${adminId}`);
    return { ...(await this.findOne(userId)), message: 'Livreur désactivé.' };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async isDriver(userId: string): Promise<boolean> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return u?.role === Role.LIVREUR;
  }

  private async getProfileOrThrow(userId: string) {
    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId },
    });
    if (!profile) {
      throw new NotFoundException(
        "Ce compte n'a pas de profil livreur. Créez-le depuis la fiche utilisateur.",
      );
    }
    return profile;
  }

  /**
   * Une plaque n'a de sens que pour un engin qui en porte une.
   *
   * La règle ne peut pas vivre en base — une colonne ne sait pas exprimer
   * « requis selon la valeur d'une autre colonne » — donc elle vit ici, à
   * l'unique point d'écriture.
   */
  private assertPlateConsistency(
    vehicleType: VehicleType,
    plateNumber?: string | null,
  ): void {
    const needsPlate =
      vehicleType === VehicleType.MOTO || vehicleType === VehicleType.VOITURE;
    if (needsPlate && !plateNumber?.trim()) {
      throw new BadRequestException(
        `Une immatriculation est requise pour un véhicule de type ${vehicleType}.`,
      );
    }
    if (!needsPlate && plateNumber?.trim()) {
      throw new BadRequestException(
        `Un véhicule de type ${vehicleType} n'a pas d'immatriculation.`,
      );
    }
  }

  private async assertZonesExist(zoneIds?: string[]): Promise<void> {
    if (!zoneIds?.length) return;
    const found = await this.prisma.quartier.count({
      where: { id: { in: zoneIds } },
    });
    if (found !== new Set(zoneIds).size) {
      throw new BadRequestException(
        'Un ou plusieurs quartiers sélectionnés sont inconnus.',
      );
    }
  }

  private async rollbackFirebaseUser(
    uid: string,
    email: string,
  ): Promise<void> {
    try {
      await this.firebase.getAuth().deleteUser(uid);
      this.logger.warn(`Compte Firebase annulé après échec : ${uid}`);
    } catch (err) {
      this.logger.error(
        `Compte Firebase orphelin ${uid} (${email}) — à supprimer manuellement dans la console : ${
          (err as Error).message
        }`,
      );
    }
  }

  private mapFirebaseCreateError(err: unknown, email: string): Error {
    const code = (err as { code?: string }).code;
    if (code === 'auth/email-already-exists') {
      return new ConflictException(
        `Un compte Firebase existe déjà pour ${email}. Si cette personne a déjà un compte client, changez son rôle depuis la fiche utilisateur.`,
      );
    }
    if (code === 'auth/invalid-email') {
      return new BadRequestException(`Adresse e-mail invalide : ${email}.`);
    }
    return new BadRequestException(
      (err as { message?: string }).message ??
        'Échec de la création du compte Firebase.',
    );
  }
}
