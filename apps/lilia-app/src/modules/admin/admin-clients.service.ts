import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Supervision clients côté admin (LIL-134) : liste recherchable, solde +
 * historique fidélité, statistiques de parrainage. Extrait de `AdminService`
 * (lectures Prisma uniquement). `AdminService` y délègue.
 */
@Injectable()
export class AdminClientsService {
  constructor(private prisma: PrismaService) {}

  async getAllClients(page = 1, limit = 20, search?: string) {
    const where: Prisma.UserWhereInput = {
      role: 'CLIENT',
      ...(search && {
        OR: [
          { nom: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [clients, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          imageUrl: true,
          role: true,
          createdAt: true,
          lastLogin: true,
          loyaltyPoints: true,
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data: clients, total, page, limit };
  }

  async getClientLoyalty(clientId: string, page = 1, limit = 20) {
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, loyaltyPoints: true },
    });
    if (!user) throw new NotFoundException('Client introuvable');

    const [transactions, total] = await Promise.all([
      this.prisma.loyaltyTransaction.findMany({
        where: { userId: clientId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.loyaltyTransaction.count({ where: { userId: clientId } }),
    ]);

    return {
      data: { balance: user.loyaltyPoints, transactions },
      total,
      page,
      limit,
    };
  }

  /**
   * Statistiques de parrainage d'un client : son code, le code de son parrain,
   * le nombre de filleuls, ceux convertis (1ʳᵉ commande livrée → referralRewarded),
   * et le total de points gagnés via le parrainage.
   */
  async getClientReferral(clientId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, referralCode: true, referredByCode: true },
    });
    if (!user) throw new NotFoundException('Client introuvable');

    const [totalReferrals, convertedReferrals, bonusAgg] = await Promise.all([
      user.referralCode
        ? this.prisma.user.count({ where: { referredByCode: user.referralCode } })
        : Promise.resolve(0),
      user.referralCode
        ? this.prisma.user.count({
            where: { referredByCode: user.referralCode, referralRewarded: true },
          })
        : Promise.resolve(0),
      this.prisma.loyaltyTransaction.aggregate({
        where: {
          userId: clientId,
          reason: { contains: 'parrainage', mode: 'insensitive' },
        },
        _sum: { points: true },
      }),
    ]);

    return {
      data: {
        referralCode: user.referralCode,
        referredByCode: user.referredByCode,
        totalReferrals,
        convertedReferrals,
        referralBonusEarned: bonusAgg._sum.points ?? 0,
      },
    };
  }
}
