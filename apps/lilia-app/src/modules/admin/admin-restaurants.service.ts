import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, VendorType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRestaurantWithOwnerDto } from './dto/create-restaurant-with-owner.dto';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Gestion des restaurants/vendeurs côté admin (LIL-134) : création d'un
 * restaurant + son propriétaire (bootstrap Firebase Auth + transaction Prisma
 * avec rollback Firebase), liste, activation/désactivation. Extrait de
 * `AdminService` — API publique inchangée.
 */
@Injectable()
export class AdminRestaurantsService {
  private readonly logger = new Logger(AdminRestaurantsService.name);

  constructor(
    private prisma: PrismaService,
    private readonly firebaseService: FirebaseService,
  ) {}

  /**
   * Crée un restaurant avec son propriétaire en une seule transaction.
   * Si l'owner n'existe pas encore, on peut le créer aussi.
   */
  async createRestaurantWithOwner(dto: CreateRestaurantWithOwnerDto) {
    const {
      email,
      password,
      nom,
      phone,
      restaurantNom,
      restaurantAdresse,
      restaurantPhone,
      restaurantImageUrl,
      vendorType,
      acceptsPreorders,
      preorderLeadHours,
      maxOrdersPerDay,
      story,
      certifications,
      specialties,
      productionNote,
    } = dto;

    // Compat. : si pas de vendorType, on garde le flux historique (RESTAURANT
    // auto-approuvé). Les nouveaux types passent toujours par la validation
    // admin (adminApproved=false), même créés via cette route.
    const effectiveType = vendorType ?? VendorType.RESTAURANT;
    const isAutoApproved = effectiveType === VendorType.RESTAURANT;

    const profileFields: Prisma.VendorProfileCreateWithoutRestaurantInput = {};
    if (story !== undefined) profileFields.story = story;
    if (certifications !== undefined) profileFields.certifications = certifications;
    if (specialties !== undefined) profileFields.specialties = specialties;
    if (productionNote !== undefined) profileFields.productionNote = productionNote;
    const hasProfile = Object.keys(profileFields).length > 0;

    // LIL-118 : on crée le user Firebase Auth AVANT la transaction Prisma.
    // Avant : l'admin devait créer l'user dans la Console et coller l'UID — UX
    // catastrophique, password DTO ignoré. Maintenant l'admin remplit juste
    // email + password et on bootstrap tout côté Firebase.
    let firebaseUid: string;
    try {
      firebaseUid = await this.firebaseService.createUser({
        email,
        password,
        displayName: nom,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      const message = (err as { message?: string }).message;
      if (code === 'auth/email-already-exists') {
        throw new BadRequestException(
          `Un compte Firebase existe déjà pour ${email}.`,
        );
      }
      if (code === 'auth/invalid-password' || code === 'auth/weak-password') {
        throw new BadRequestException(
          'Mot de passe invalide (min 6 caractères).',
        );
      }
      throw new BadRequestException(
        message ?? 'Échec de la création du compte Firebase.',
      );
    }

    // Si la transaction Prisma échoue, on supprime le user Firebase qu'on
    // vient de créer pour ne pas laisser de zombie côté Firebase Console.
    try {
      return await this.prisma.$transaction(async (tx) => {
        // L'user Firebase étant tout neuf, il ne devrait JAMAIS exister
        // déjà en DB. On garde quand même le findUnique par sécurité
        // (concurrent webhook /users/sync, par ex.).
        let owner = await tx.user.findUnique({
          where: { firebaseUid },
        });

        if (!owner) {
          owner = await tx.user.create({
            data: {
              firebaseUid,
              email,
              nom: nom || email.split('@')[0],
              phone: phone ?? '',
              role: 'RESTAURATEUR',
            },
          });
          this.logger.log(`Owner créé : ${owner.id}`);
        } else if (owner.role !== 'RESTAURATEUR' && owner.role !== 'ADMIN') {
          owner = await tx.user.update({
            where: { id: owner.id },
            data: { role: 'RESTAURATEUR' },
          });
        }

        // Vérifie qu'il n'a pas déjà un restaurant
        const existing = await tx.restaurant.findUnique({
          where: { ownerId: owner.id },
        });
        if (existing) {
          throw new BadRequestException(
            'Cet utilisateur possède déjà un restaurant.',
          );
        }

        const restaurant = await tx.restaurant.create({
          data: {
            nom: restaurantNom,
            adresse: restaurantAdresse,
            phone: restaurantPhone,
            imageUrl: restaurantImageUrl,
            vendorType: effectiveType,
            adminApproved: isAutoApproved,
            adminApprovedAt: isAutoApproved ? new Date() : null,
            acceptsPreorders: acceptsPreorders ?? false,
            preorderLeadHours,
            maxOrdersPerDay,
            owner: { connect: { id: owner.id } },
            ...(hasProfile && {
              vendorProfile: { create: profileFields },
            }),
          },
          include: {
            owner: { select: { id: true, email: true, role: true } },
            vendorProfile: true,
          },
        });

        this.logger.log(
          `Vendeur ${effectiveType} créé par admin : ${restaurant.id} (adminApproved=${isAutoApproved})`,
        );
        return {
          data: restaurant,
          message: isAutoApproved
            ? 'Restaurant et propriétaire créés avec succès'
            : `${effectiveType} créé — en attente de validation`,
        };
      });
    } catch (err) {
      // Rollback Firebase user : la transaction Prisma a échoué, on ne
      // laisse pas un compte Firebase orphelin sans entrée DB associée.
      // deleteUserSafe absorbe ses propres erreurs.
      await this.firebaseService.deleteUserSafe(firebaseUid);
      throw err;
    }
  }

  async getAllRestaurants() {
    const restaurants = await this.prisma.restaurant.findMany({
      include: {
        owner: { select: { id: true, email: true, nom: true, phone: true } },
        specialties: true,
        _count: { select: { orders: true, products: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { data: restaurants, total: restaurants.length };
  }

  async toggleRestaurantActive(restaurantId: string, isActive: boolean) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });
    if (!restaurant) throw new NotFoundException('Restaurant non trouvé');

    const updated = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { isActive, isOpen: isActive ? restaurant.isOpen : false },
    });

    this.logger.warn(
      `Restaurant ${restaurantId} ${isActive ? 'activé' : 'désactivé'} par admin`,
    );
    return {
      data: updated,
      message: isActive ? 'Restaurant activé' : 'Restaurant désactivé',
    };
  }
}
