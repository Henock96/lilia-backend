/* eslint-disable prettier/prettier */
// src/user/user.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { UpdateUserDto } from './dto/update-user.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { DecodedIdToken } from 'firebase-admin/auth';
import { UserCreatedEvent, UserPhoneCompletedEvent } from '../events/user-events';
import { UserCacheService } from '../auth/services/user-cache.service';


@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private userCache: UserCacheService,
  ) {}

  /**
   * Crée un user manuellement (usage interne ou seed).
   * Pour la sync Firebase, préférer syncUserFromFirebase().
   */
  async createUser(data: Prisma.UserCreateInput) {
    return this.prisma.user.create({
      data,
    });
  }
   /**
   * Récupère un user par son UID Firebase.
   * Inclut le restaurant pour les RESTAURATEUR (utile dans les guards/controllers).
   */
  async findByFirebaseUid(firebaseUid: string) {
    return this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        restaurant: true, // Inclure le restaurant pour les admins/restaurateurs
      },
    });
  }

  /**
   * Synchronise un utilisateur Firebase avec la base de données.
   *
   * Logique :
   * - Si le user n'existe pas → création + émission de user.created
   * - Si le user existe → mise à jour des champs modifiables (email, nom, imageUrl)
   *
   * Appelé par l'AuthController à chaque connexion/inscription depuis l'app mobile.
   * Le token Firebase décodé est le seul paramètre — pas de any.
   */
  private generateReferralCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  private async generateUniqueReferralCode(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const code = this.generateReferralCode();
      const existing = await this.prisma.user.findUnique({ where: { referralCode: code } });
      if (!existing) return code;
    }
    return `LF${Date.now().toString(36).toUpperCase().slice(-6)}`;
  }

  async getReferralStats(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true, loyaltyPoints: true },
    });

    const totalReferrals = user?.referralCode
      ? await this.prisma.user.count({ where: { referredByCode: user.referralCode } })
      : 0;

    const rewardedReferrals = user?.referralCode
      ? await this.prisma.user.count({
          where: { referredByCode: user.referralCode, referralRewarded: true },
        })
      : 0;

    return {
      referralCode: user?.referralCode ?? null,
      totalReferrals,
      rewardedReferrals,
      loyaltyPoints: user?.loyaltyPoints ?? 0,
    };
  }

  async getLoyaltyTransactions(userId: string) {
    const transactions = await this.prisma.loyaltyTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return { data: transactions };
  }

  async syncFromFirebase(decoded: DecodedIdToken, phone?: string, referralCode?: string) {
    const { uid, email, name, picture } = decoded;

    // Log structuré début sync pour tracer signups manquants en BDD (LIL-XX)
    this.logger.log(
      `[SYNC START] firebaseUid=${uid} email=${email ?? 'unknown'} phone=${phone ?? 'none'} referralCode=${referralCode ?? 'none'}`,
    );

    // Vérifier d'abord si l'utilisateur existe
    const existingUser = await this.prisma.user.findUnique({
      where: { firebaseUid: uid },
    });

    const isNewUser = !existingUser;

    // Upsert : créer si n'existe pas, mettre à jour si existe
    // Valider le code de parrainage si fourni
    let validReferredByCode: string | null = null;
    if (referralCode && isNewUser === false) {
      // Ignorer si le user existe déjà (pas de rétro-application)
    } else if (referralCode && isNewUser !== false) {
      const referrer = await this.prisma.user.findUnique({ where: { referralCode } });
      if (referrer) validReferredByCode = referralCode;
    }

    const user = await this.prisma.user.upsert({
      where: { firebaseUid: uid },
      create: {
        firebaseUid: uid,
        email: email ?? '',
        nom: name ?? email?.split('@')[0] ?? 'Utilisateur',
        phone: phone ?? '',
        imageUrl: picture ?? null,
        role: 'CLIENT',
        referralCode: await this.generateUniqueReferralCode(),
        referredByCode: validReferredByCode,
      },
      update: {
        ...(email && { email }),
        ...(name && { nom: name }),
        ...(picture && { imageUrl: picture }),
        ...(phone && { phone }),
        lastLogin: new Date(),
      }
    });

    // Le upsert update lastLogin/email/nom à chaque sync → invalider le cache pour
    // garantir que la prochaine requête authentifiée voit le User à jour.
    await this.userCache.invalidate(user.firebaseUid);

    // Log structuré fin sync (succès) — utilisé pour tracer signups manquants
    this.logger.log(
      `[SYNC SUCCESS] userId=${user.id} firebaseUid=${user.firebaseUid} email=${user.email} isNewUser=${isNewUser}`,
    );

    // Émettre l'événement uniquement pour les nouveaux utilisateurs
    if (isNewUser) {
      const userCreatedEvent = new UserCreatedEvent(
        user.id,
        user.nom,
        user.createdAt
      );
      this.eventEmitter.emit('user.created', userCreatedEvent);
    }

    return { user, isNewUser };
  }

  async findById(id: string) : Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async updateUser(id: string, data: UpdateUserDto): Promise<User> {
    const updated = await this.prisma.user.update({
      where: { id },
      data,
    });
    await this.userCache.invalidate(updated.firebaseUid);
    // Numero (re)saisi via PUT /users/me — declenche le SMS de bienvenue cote
    // Google. Le UserListener filtre via le flag welcomeSmsSentAt + fenetre 24h,
    // donc emettre a chaque mise a jour de numero est idempotent.
    if (data.phone && data.phone.trim().length > 0) {
      this.eventEmitter.emit('user.phone.completed', new UserPhoneCompletedEvent(id));
    }
    return updated;
  }

  async findUserOrders(userId: string) {
    return this.prisma.order.findMany({
      where: {
        userId: userId,
      },
      include: {
        items: true, // Inclure les détails des articles de la commande
        restaurant: {
          select: {
            nom: true, // On peut aussi inclure le nom du restaurant
          }
        }
      },
      orderBy: {
        createdAt: 'desc', // Trier par date de création, la plus récente en premier
      },
    });
  }
}
