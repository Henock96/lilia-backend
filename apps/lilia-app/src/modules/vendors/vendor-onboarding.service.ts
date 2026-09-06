import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AdminAuditAction,
  DeliveryPriceMode,
  OnboardingStatus,
  Prisma,
  Role,
  VendorType,
} from '@prisma/client';
import { randomBytes } from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { FirebaseService } from '../firebase/firebase.service';
import { OutboxService } from '../outbox/outbox.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { PhotosCommonService } from '../photos-common/photos-common.service';
import { assertZoneCoverage } from '../../common/delivery/zone-coverage';
import { defaultCategoriesCreateInput } from '../categories/category.includes';
import {
  VendorReadinessService,
  ReadinessReport,
} from './vendor-readiness.service';
import {
  VENDOR_INVITATION_EVENT,
  VendorActivatedEvent,
  VendorCreatedEvent,
  VendorReadyEvent,
} from './events/vendor-events';
import {
  ActivateVendorDto,
  CreateVendorOnboardingDto,
  UpdateVendorCommerceDto,
  UpdateVendorDeliveryDto,
  UpdateVendorIdentityDto,
  UpdateVendorLocationDto,
} from './dto/onboarding.dto';

@Injectable()
export class VendorOnboardingService {
  private readonly logger = new Logger(VendorOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseService,
    private readonly readiness: VendorReadinessService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly audit: AdminAuditService,
    private readonly photos: PhotosCommonService,
    private readonly events: EventEmitter2,
  ) {}

  // ─── Étape 1 — création ────────────────────────────────────────────────────

  /**
   * Crée le vendeur et le compte de son propriétaire, en `DRAFT`.
   *
   * Trois différences avec `createRestaurantWithOwner`, qu'il remplace :
   *
   * 1. **Aucun mot de passe n'est choisi par l'administrateur.** Le compte naît
   *    avec un secret jetable et le vendeur définit le sien via un lien
   *    d'activation Firebase. L'admin n'a donc jamais à transmettre de secret
   *    permanent par un canal qu'il ne maîtrise pas.
   * 2. **Le vendeur naît invisible** (`DRAFT`, `isOpen: false`) : il ne peut
   *    plus recevoir de commande avant d'avoir horaires, GPS et catalogue.
   * 3. **L'obligation de l'inviter est écrite dans la transaction**
   *    (`OutboxEvent`) : si le vendeur existe, l'invitation est due, et le
   *    dispatcher s'en charge même si l'envoi immédiat échoue.
   */
  async createVendor(
    dto: CreateVendorOnboardingDto,
    adminId: string,
    idempotencyKey?: string,
  ) {
    return this.idempotency.runOnce('vendor-onboarding', idempotencyKey, () =>
      this.doCreateVendor(dto, adminId),
    );
  }

  private async doCreateVendor(
    dto: CreateVendorOnboardingDto,
    adminId: string,
  ) {
    const email = dto.ownerEmail.trim().toLowerCase();

    // Contrôle préalable pour un message utile. La garantie reste la contrainte
    // `User.email @unique` plus bas — entre ce SELECT et le INSERT, un autre
    // admin peut créer le même compte.
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true, restaurant: { select: { id: true } } },
    });
    if (existing) {
      throw new ConflictException(
        existing.restaurant
          ? `${email} possède déjà une boutique sur la plateforme.`
          : `${email} a déjà un compte client. Changez son rôle en RESTAURATEUR puis rattachez-lui une boutique, plutôt que de créer un doublon.`,
      );
    }

    // Mot de passe jetable : jamais journalisé, jamais retourné, jamais connu
    // de personne. Il n'existe que pour satisfaire l'API Firebase, qui exige un
    // secret à la création ; le vendeur le remplacera au premier accès.
    const throwawayPassword = randomBytes(32).toString('base64url');

    let firebaseUid: string;
    try {
      firebaseUid = await this.firebase.createUser({
        email,
        password: throwawayPassword,
        displayName: dto.ownerNom,
      });
    } catch (err: unknown) {
      throw this.mapFirebaseCreateError(err, email);
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const owner = await tx.user.create({
          data: {
            firebaseUid,
            email,
            nom: dto.ownerNom.trim(),
            phone: dto.ownerPhone.trim(),
            role: Role.RESTAURATEUR,
          },
        });

        const vendor = await tx.restaurant.create({
          data: {
            nom: dto.nom.trim(),
            description: dto.description?.trim() || null,
            adresse: dto.adresse.trim(),
            phone: dto.phone.trim(),
            vendorType: dto.vendorType,
            ownerId: owner.id,
            onboardingStatus: OnboardingStatus.DRAFT,
            // Un vendeur en cours de configuration ne prend pas de commande.
            isOpen: false,
            // La validation marketplace reste indépendante de l'onboarding :
            // un RESTAURANT est auto-approuvé comme historiquement, les autres
            // types passent par un admin. Ce n'est pas la même question que
            // « sa boutique est-elle configurée ».
            adminApproved: dto.vendorType === VendorType.RESTAURANT,
            adminApprovedAt:
              dto.vendorType === VendorType.RESTAURANT ? new Date() : null,
            adminApprovedById:
              dto.vendorType === VendorType.RESTAURANT ? adminId : null,
            // Squelette d'horaires : les 7 jours fermés, prêts à être ouverts.
            // Une grille vide à remplir est plus lisible qu'un écran vide, et
            // le vendeur reste fermé tant qu'il n'a rien ouvert.
            operatingHours: {
              create: WEEK_DAYS.map((dayOfWeek) => ({
                dayOfWeek,
                openTime: '08:00',
                closeTime: '20:00',
                isClosed: true,
              })),
            },
            // Sections de menu par défaut — même raison que la grille
            // d'horaires ci-dessus : une carte pré-remplie à ajuster vaut mieux
            // qu'un écran vide, et le catalogue est un critère bloquant de
            // l'activation.
            categories: {
              create: defaultCategoriesCreateInput(dto.vendorType),
            },
          },
        });

        await this.outbox.enqueueInTransaction(tx, {
          type: VENDOR_INVITATION_EVENT,
          aggregateId: vendor.id,
          payload: { email, nom: dto.ownerNom, phone: dto.ownerPhone },
        });

        return { owner, vendor };
      });

      await this.audit.record({
        actorId: adminId,
        action: AdminAuditAction.VENDOR_CREATED,
        targetType: 'Restaurant',
        targetId: created.vendor.id,
        metadata: {
          vendorType: dto.vendorType,
          ownerId: created.owner.id,
          ownerEmail: email,
        },
      });

      this.events.emit(
        'vendor.created',
        new VendorCreatedEvent(created.vendor, adminId),
      );

      this.logger.log(
        `Vendeur ${dto.vendorType} créé en DRAFT : ${created.vendor.nom} (${created.vendor.id})`,
      );

      const report = await this.readiness.getReport(created.vendor.id);
      return {
        data: { vendor: created.vendor, readiness: report },
        message: `${created.vendor.nom} créé. Une invitation part vers ${email} pour qu'il définisse son mot de passe.`,
      };
    } catch (err) {
      // La transaction a échoué : le compte Firebase n'a plus de contrepartie
      // en base. On le supprime, et si cette suppression échoue elle aussi, on
      // laisse une trace exploitable plutôt qu'un compte fantôme silencieux —
      // sans quoi l'e-mail reste réservé et aucune nouvelle tentative ne passe.
      await this.rollbackFirebaseUser(firebaseUid, email);
      throw err;
    }
  }

  // ─── Étapes 2 à 7 — configuration ──────────────────────────────────────────

  async updateIdentity(restaurantId: string, dto: UpdateVendorIdentityDto) {
    const current = await this.getOrThrow(restaurantId);

    const data: Prisma.RestaurantUpdateInput = {};
    if (dto.nom !== undefined) data.nom = dto.nom.trim();
    if (dto.description !== undefined)
      data.description = dto.description.trim() || null;
    if (dto.phone !== undefined) data.phone = dto.phone.trim();
    if (dto.email !== undefined) data.email = dto.email.trim() || null;
    if (dto.imageUrl !== undefined) {
      data.imageUrl = dto.imageUrl.trim() || null;
      data.imagePublicId = dto.imagePublicId?.trim() || null;
    }

    const updated = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data,
    });

    // Le logo a changé : l'ancien fichier n'est plus référencé nulle part.
    // Après le commit, jamais avant — supprimer une image dont l'écriture
    // échouerait ensuite laisserait le vendeur sans logo du tout.
    if (
      dto.imageUrl !== undefined &&
      current.imagePublicId &&
      current.imagePublicId !== dto.imagePublicId
    ) {
      await this.photos.cleanupCloudinary(current.imagePublicId);
    }

    if (dto.specialties)
      await this.replaceSpecialties(restaurantId, dto.specialties);

    return this.withReadiness(updated.id, 'Identité mise à jour');
  }

  async updateLocation(restaurantId: string, dto: UpdateVendorLocationDto) {
    await this.getOrThrow(restaurantId);

    if (dto.quartierId) {
      const quartier = await this.prisma.quartier.findUnique({
        where: { id: dto.quartierId },
        select: { id: true },
      });
      if (!quartier) throw new BadRequestException('Quartier inconnu.');
    }

    const data: Prisma.RestaurantUpdateInput = {};
    if (dto.adresse !== undefined) data.adresse = dto.adresse.trim();
    if (dto.latitude !== undefined) data.latitude = dto.latitude;
    if (dto.longitude !== undefined) data.longitude = dto.longitude;
    if (dto.deliveryInstructions !== undefined)
      data.deliveryInstructions = dto.deliveryInstructions.trim() || null;
    if (dto.quartierId !== undefined) {
      data.quartier = dto.quartierId
        ? { connect: { id: dto.quartierId } }
        : { disconnect: true };
    }

    await this.prisma.restaurant.update({ where: { id: restaurantId }, data });
    return this.withReadiness(restaurantId, 'Localisation mise à jour');
  }

  async updateDelivery(restaurantId: string, dto: UpdateVendorDeliveryDto) {
    const current = await this.getOrThrow(restaurantId);

    const supportsDelivery = dto.supportsDelivery ?? current.supportsDelivery;
    const supportsPickup = dto.supportsPickup ?? current.supportsPickup;
    if (!supportsDelivery && !supportsPickup) {
      throw new BadRequestException(
        'Un vendeur doit accepter au moins la livraison ou le retrait — sinon aucun client ne peut être servi.',
      );
    }

    // Validation croisée absente jusqu'ici : seul le formulaire web la faisait,
    // donc l'app Flutter et l'API pouvaient enregistrer « entre 45 et 20 min ».
    const min =
      dto.estimatedDeliveryTimeMin ?? current.estimatedDeliveryTimeMin;
    const max =
      dto.estimatedDeliveryTimeMax ?? current.estimatedDeliveryTimeMax;
    if (min > max) {
      throw new BadRequestException(
        `Le délai minimum (${min} min) ne peut pas dépasser le délai maximum (${max} min).`,
      );
    }

    // Fix L-3 : la checklist d'activation refusait déjà « ZONE_BASED sans
    // zone », mais elle ne garde que la publication. Ce chemin-ci reste ouvert
    // toute la vie du vendeur — c'est celui qu'il faut fermer pour que
    // l'invariant tienne après l'activation, pas seulement avant.
    const nextMode = dto.deliveryPriceMode ?? current.deliveryPriceMode;
    if (nextMode === DeliveryPriceMode.ZONE_BASED && supportsDelivery) {
      const zoneCount = await this.prisma.deliveryZone.count({
        where: { restaurantId },
      });
      assertZoneCoverage(nextMode, zoneCount, supportsDelivery);
    }

    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        supportsDelivery,
        supportsPickup,
        ...(dto.deliveryPriceMode !== undefined && {
          deliveryPriceMode: dto.deliveryPriceMode,
        }),
        ...(dto.fixedDeliveryFee !== undefined && {
          fixedDeliveryFee: dto.fixedDeliveryFee,
        }),
        ...(dto.estimatedDeliveryTimeMin !== undefined && {
          estimatedDeliveryTimeMin: dto.estimatedDeliveryTimeMin,
        }),
        ...(dto.estimatedDeliveryTimeMax !== undefined && {
          estimatedDeliveryTimeMax: dto.estimatedDeliveryTimeMax,
        }),
        ...(dto.minimumOrderAmount !== undefined && {
          minimumOrderAmount: dto.minimumOrderAmount,
        }),
        ...(dto.deliveryInstructions !== undefined && {
          deliveryInstructions: dto.deliveryInstructions.trim() || null,
        }),
      },
    });

    return this.withReadiness(
      restaurantId,
      'Paramètres de livraison mis à jour',
    );
  }

  /** ADMIN uniquement — porte la commission, donc la marge de la plateforme. */
  async updateCommerce(
    restaurantId: string,
    dto: UpdateVendorCommerceDto,
    adminId: string,
  ) {
    const current = await this.getOrThrow(restaurantId);

    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        ...(dto.commissionPercent !== undefined && {
          commissionPercent: dto.commissionPercent,
        }),
        ...(dto.minimumOrderAmount !== undefined && {
          minimumOrderAmount: dto.minimumOrderAmount,
        }),
        ...(dto.acceptsPreorders !== undefined && {
          acceptsPreorders: dto.acceptsPreorders,
        }),
        ...(dto.preorderLeadHours !== undefined && {
          preorderLeadHours: dto.preorderLeadHours,
        }),
        ...(dto.maxOrdersPerDay !== undefined && {
          maxOrdersPerDay: dto.maxOrdersPerDay,
        }),
      },
    });

    if (
      dto.commissionPercent !== undefined &&
      dto.commissionPercent !== current.commissionPercent
    ) {
      await this.audit.record({
        actorId: adminId,
        action: AdminAuditAction.VENDOR_COMMISSION_CHANGED,
        targetType: 'Restaurant',
        targetId: restaurantId,
        metadata: {
          from: current.commissionPercent,
          to: dto.commissionPercent,
        },
      });
    }

    return this.withReadiness(
      restaurantId,
      'Paramètres commerciaux mis à jour',
    );
  }

  // ─── Étape 9 — état de l'onboarding ────────────────────────────────────────

  async getOnboardingState(restaurantId: string) {
    const report = await this.readiness.getReport(restaurantId);
    if (!report) throw new NotFoundException('Vendeur introuvable.');

    // Le statut suit la checklist : atteindre READY n'est pas un geste, c'est
    // une conséquence. Seule l'activation reste une décision humaine.
    const synced = await this.syncOnboardingStatus(report);
    return { data: { ...report, onboardingStatus: synced } };
  }

  // ─── Étape 10 — activation ─────────────────────────────────────────────────

  async activate(
    restaurantId: string,
    adminId: string,
    dto: ActivateVendorDto,
  ) {
    const report = await this.readiness.getReport(restaurantId);
    if (!report) throw new NotFoundException('Vendeur introuvable.');

    if (!report.isReady) {
      throw new ConflictException({
        message:
          'Ce vendeur ne peut pas être activé : sa configuration est incomplète.',
        blockingIssues: report.blockingIssues,
        checks: report.checks.filter((c) => c.blocking && c.status !== 'OK'),
      });
    }

    if (!dto.skipRecommendations) {
      const recommended = report.checks.filter(
        (c) => !c.blocking && c.status !== 'OK',
      );
      if (recommended.length > 0) {
        throw new ConflictException({
          message:
            'Des éléments recommandés manquent. Complétez-les, ou renvoyez la requête avec `skipRecommendations: true` pour activer malgré tout.',
          recommendations: recommended,
        });
      }
    }

    // `updateMany` conditionné sur l'état lu : deux admins qui cliquent en même
    // temps ne produisent qu'une activation, et donc qu'une notification.
    const claimed = await this.prisma.restaurant.updateMany({
      where: {
        id: restaurantId,
        onboardingStatus: { not: OnboardingStatus.ACTIVATED },
      },
      data: {
        onboardingStatus: OnboardingStatus.ACTIVATED,
        activatedAt: new Date(),
        activatedById: adminId,
        // L'ouverture effective revient au cron, selon les horaires saisis :
        // activer à 23 h ne doit pas ouvrir une boutique qui ferme à 20 h.
        manualOverride: false,
      },
    });

    if (claimed.count === 0) {
      throw new ConflictException('Ce vendeur est déjà activé.');
    }

    const vendor = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
    });

    await this.audit.record({
      actorId: adminId,
      action: AdminAuditAction.VENDOR_ACTIVATED,
      targetType: 'Restaurant',
      targetId: restaurantId,
      metadata: { vendorType: vendor.vendorType },
    });

    this.events.emit(
      'vendor.activated',
      new VendorActivatedEvent(vendor, adminId),
    );

    this.logger.log(`Vendeur activé : ${vendor.nom} (${restaurantId})`);
    return {
      data: vendor,
      message: vendor.adminApproved
        ? `${vendor.nom} est activé et visible par les clients.`
        : `${vendor.nom} est activé, en attente de validation marketplace.`,
    };
  }

  // ─── Aperçu client ─────────────────────────────────────────────────────────

  /**
   * Rend le vendeur tel que le client le verra, avant qu'il soit publié.
   *
   * Utilise volontairement les mêmes champs et le même tri que le détail public
   * (`VendorsService.findOne`) : un aperçu qui ne reflète pas la vraie page ne
   * sert à rien. La différence est le filtre — celui-ci ignore
   * `onboardingStatus`, `adminApproved` et `isActive`, puisque c'est justement
   * ce qu'on vérifie avant de l'accorder.
   */
  async preview(restaurantId: string) {
    const now = new Date();
    const vendor = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        vendorProfile: true,
        operatingHours: { orderBy: { dayOfWeek: 'asc' } },
        specialties: true,
        quartier: { select: { id: true, nom: true, ville: true } },
        photos: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
        products: {
          where: { deletedAt: null, isAvailable: true },
          include: {
            category: true,
            variants: true,
            images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        },
        menuDuJour: {
          where: {
            isActive: true,
            dateDebut: { lte: now },
            dateFin: { gte: now },
          },
          include: { images: true },
        },
        _count: { select: { products: true } },
      },
    });
    if (!vendor) throw new NotFoundException('Vendeur introuvable.');

    const report = await this.readiness.getReport(restaurantId);
    return { data: { vendor, readiness: report } };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Aligne `onboardingStatus` sur la checklist, sans jamais toucher `ACTIVATED`.
   *
   * Un vendeur déjà activé qui supprimerait son dernier produit ne doit pas
   * être rétrogradé automatiquement : le retirer du catalogue sans décision
   * humaine transformerait une erreur de saisie en rupture de service. Il
   * apparaît alors « activé mais incomplet », ce que la checklist signale.
   */
  private async syncOnboardingStatus(
    report: ReadinessReport,
  ): Promise<OnboardingStatus> {
    if (report.onboardingStatus === OnboardingStatus.ACTIVATED) {
      return OnboardingStatus.ACTIVATED;
    }
    const target = report.isReady
      ? OnboardingStatus.READY
      : OnboardingStatus.DRAFT;
    if (target === report.onboardingStatus) return target;

    const changed = await this.prisma.restaurant.updateMany({
      where: {
        id: report.restaurantId,
        onboardingStatus: { not: OnboardingStatus.ACTIVATED },
      },
      data: { onboardingStatus: target },
    });

    // `changed.count` conditionne l'émission : la checklist est recalculée à
    // chaque PATCH, et sans cette garde un vendeur déjà READY émettrait
    // « prêt à activer » à chaque retouche de son adresse.
    if (changed.count > 0 && target === OnboardingStatus.READY) {
      const vendor = await this.prisma.restaurant.findUnique({
        where: { id: report.restaurantId },
      });
      if (vendor)
        this.events.emit('vendor.ready', new VendorReadyEvent(vendor));
    }
    return target;
  }

  private async withReadiness(restaurantId: string, message: string) {
    const report = await this.readiness.getReport(restaurantId);
    if (report) await this.syncOnboardingStatus(report);
    const vendor = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      include: { operatingHours: true, specialties: true, quartier: true },
    });
    return { data: { vendor, readiness: report }, message };
  }

  /**
   * Charge le vendeur ou lève un 404. Renvoie la ligne entière plutôt qu'une
   * projection : un `select` générique demandait un cast que TypeScript ne peut
   * pas vérifier, et l'économie d'une poignée de colonnes sur une écriture ne
   * la justifiait pas.
   */
  private async getOrThrow(restaurantId: string) {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });
    if (!vendor) throw new NotFoundException('Vendeur introuvable.');
    return vendor;
  }

  private async replaceSpecialties(restaurantId: string, names: string[]) {
    const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    await this.prisma.$transaction([
      this.prisma.specialty.deleteMany({ where: { restaurantId } }),
      ...(clean.length
        ? [
            this.prisma.specialty.createMany({
              data: clean.map((name) => ({ name, restaurantId })),
            }),
          ]
        : []),
    ]);
  }

  private async rollbackFirebaseUser(
    uid: string,
    email: string,
  ): Promise<void> {
    try {
      await this.firebase.getAuth().deleteUser(uid);
      this.logger.warn(`Compte Firebase annulé après échec : ${uid}`);
    } catch (err) {
      // Sans cette trace, l'adresse resterait réservée côté Firebase et toute
      // nouvelle tentative échouerait en « email déjà utilisé », sans que rien
      // n'indique pourquoi. C'est le trou signalé par l'audit (V14).
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
        `Un compte Firebase existe déjà pour ${email}. Si cette personne est déjà cliente, changez son rôle en RESTAURATEUR au lieu de créer un second compte.`,
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

const WEEK_DAYS = [
  'LUNDI',
  'MARDI',
  'MERCREDI',
  'JEUDI',
  'VENDREDI',
  'SAMEDI',
  'DIMANCHE',
] as const;
