import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DeliveryStatus,
  DriverSettlementMethod,
  DriverSettlementStatus,
  Prisma,
  Role,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** Ce que Lilia Food doit à un livreur à un instant donné. */
export interface DriverOutstanding {
  driverId: string;
  /** Coupure retenue. Aucune course livrée après n'est comptée. */
  coveredUntil: Date;
  amountXaf: number;
  courseCount: number;
  /** Première course non réglée, ou `null` s'il n'y en a aucune. */
  periodStart: Date | null;
  currency: string;
}

/**
 * Règlement de ce que Lilia Food doit à ses livreurs.
 *
 * ## Un registre, pas un rail de paiement
 *
 * Ce service ne déclenche aucun virement, et c'est délibéré (décision D-6). Le
 * rail automatique est éteint en production, la capacité PAYOUT de pawaPay n'a
 * jamais été validée, et aucun livreur n'a de compte de versement enregistré.
 * L'argent est remis hors application ; ce service en tient la comptabilité.
 *
 * ## Un seul temps
 *
 * Consulter ce qui est dû est une **lecture pure** : elle ne crée rien et ne
 * verrouille rien. Le règlement n'est écrit qu'**après** la remise de l'argent.
 *
 * Un état d'attente aurait décrit un moment qui n'existe pas ici — l'argent
 * passe de la main à la main — et son effet réel aurait été de verrouiller les
 * courses d'un livreur dès qu'un administrateur est interrompu entre les deux
 * gestes. Un enregistrement qui ressemble à une donnée sans rien signifier est
 * exactement ce que cette phase s'emploie à supprimer.
 */
@Injectable()
export class DriverSettlementService {
  private readonly logger = new Logger(DriverSettlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Filtre des courses réglables. Écrit **une fois** et réutilisé par la
   * lecture et par l'écriture : deux expressions d'une même règle finissent
   * par diverger, et la divergence se verrait ici sur un montant versé.
   */
  private payableWhere(
    driverId: string,
    coveredUntil: Date,
  ): Prisma.DeliveryWhereInput {
    return {
      delivererId: driverId,
      // Pas encore couverte par un règlement.
      driverSettlementId: null,
      // Le gel est exigé : une course sans économie n'a pas de montant dû, et
      // on ne lui en invente pas.
      driverEconomicsFrozenAt: { not: null },
      OR: [
        { status: DeliveryStatus.LIVRER, deliveredAt: { lte: coveredUntil } },
        // F3-05 — une course échouée dont le livreur ne répond pas (client,
        // vendeur ou plateforme responsable) lui est payée ; l'échec
        // simplement déclaré, pas encore arbitré, ne l'est pas.
        {
          status: DeliveryStatus.ECHEC,
          failedAt: { lte: coveredUntil },
          order: {
            status: 'ECHEC_LIVRAISON',
            failureLiability: { in: ['CLIENT', 'VENDOR', 'PLATFORM'] },
          },
        },
      ],
    };
  }

  private async assertDriver(driverId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: driverId },
      select: { id: true, role: true },
    });
    if (!user || user.role !== Role.LIVREUR) {
      throw new NotFoundException('Livreur introuvable.');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Lecture — ne verrouille rien
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Ce qui reste dû à un livreur pour ses courses livrées jusqu'à `coveredUntil`.
   *
   * ⚠️ Aucune écriture. C'est ce qui la distingue d'un « compte arrêté » : le
   * montant peut être consulté autant de fois qu'on veut, par n'importe qui
   * d'autorisé, sans rien immobiliser.
   */
  async getOutstanding(
    driverId: string,
    coveredUntil: Date,
  ): Promise<DriverOutstanding> {
    await this.assertDriver(driverId);

    const courses = await this.prisma.delivery.findMany({
      where: this.payableWhere(driverId, coveredUntil),
      select: {
        id: true,
        driverPayXaf: true,
        deliveredAt: true,
        failedAt: true,
      },
    });

    return {
      driverId,
      coveredUntil,
      amountXaf: courses.reduce((sum, c) => sum + (c.driverPayXaf ?? 0), 0),
      courseCount: courses.length,
      periodStart: periodStart(courses),
      currency: 'XAF',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Écriture — après que l'argent a été remis
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Enregistre un règlement **déjà versé**.
   *
   * `coveredUntil` vient de l'appelant, et jamais d'un `now()` pris ici :
   * entre l'instant où l'administrateur a lu « 3 500 XAF » et celui où il
   * enregistre, le livreur a pu terminer deux courses. Les absorber dans un
   * montant déjà convenu et déjà remis le sous-paierait, en silence.
   */
  async record(params: {
    driverId: string;
    coveredUntil: Date;
    method: DriverSettlementMethod;
    adminId: string;
    paidAt?: Date;
    reference?: string;
    note?: string;
  }) {
    await this.assertDriver(params.driverId);

    const courses = await this.prisma.delivery.findMany({
      where: this.payableWhere(params.driverId, params.coveredUntil),
      select: {
        id: true,
        driverPayXaf: true,
        deliveredAt: true,
        failedAt: true,
      },
    });

    if (courses.length === 0) {
      throw new BadRequestException(
        'Aucune course à régler pour ce livreur sur cette période.',
      );
    }

    const amountXaf = courses.reduce(
      (sum, c) => sum + (c.driverPayXaf ?? 0),
      0,
    );
    const ids = courses.map((c) => c.id);

    return this.prisma.$transaction(async (tx) => {
      const settlement = await tx.driverSettlement.create({
        data: {
          driverId: params.driverId,
          amountXaf,
          courseCount: courses.length,
          // Non nul : une course payable est livrée (`deliveredAt`) ou échouée
          // sans faute du livreur (`failedAt`) — le filtre exige l'un ou l'autre.
          periodStart: periodStart(courses)!,
          coveredUntil: params.coveredUntil,
          status: DriverSettlementStatus.PAID,
          method: params.method,
          reference: params.reference ?? null,
          note: params.note ?? null,
          paidAt: params.paidAt ?? new Date(),
          recordedBy: params.adminId,
        },
      });

      // Verrou porté par la BASE, pas par un `if` en amont : le `where` exige
      // que chaque course soit encore non réglée. Deux administrateurs
      // simultanés ne peuvent donc pas couvrir deux fois les mêmes courses.
      const attached = await tx.delivery.updateMany({
        where: { id: { in: ids }, driverSettlementId: null },
        data: { driverSettlementId: settlement.id },
      });

      if (attached.count !== ids.length) {
        // Une course a été raflée entre la lecture et l'écriture. On annule
        // TOUT : un règlement qui couvrirait moins de courses que le montant
        // remis laisserait une dette invisible, et l'argent est déjà parti.
        throw new ConflictException(
          'Certaines courses viennent d’être réglées par ailleurs. ' +
            'Rechargez le décompte avant d’enregistrer ce versement.',
        );
      }

      this.logger.log(
        `💵 Règlement livreur ${params.driverId} — ${amountXaf} XAF, ` +
          `${courses.length} course(s), ${params.method}, par ${params.adminId}`,
      );

      return settlement;
    });
  }

  /**
   * Annule une saisie erronée et **libère les courses**.
   *
   * Sans cette libération, corriger une faute de frappe rendrait la dette
   * définitivement impayable : les courses resteraient rattachées à un
   * règlement annulé, donc hors de tout décompte futur.
   */
  async cancel(settlementId: string, adminId: string, reason: string) {
    const existing = await this.prisma.driverSettlement.findUnique({
      where: { id: settlementId },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('Règlement introuvable.');
    if (existing.status === DriverSettlementStatus.CANCELLED) {
      throw new ConflictException('Ce règlement est déjà annulé.');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.delivery.updateMany({
        where: { driverSettlementId: settlementId },
        data: { driverSettlementId: null },
      });

      return tx.driverSettlement.update({
        where: { id: settlementId },
        data: {
          status: DriverSettlementStatus.CANCELLED,
          cancelledBy: adminId,
          cancelledAt: new Date(),
          cancelReason: reason,
        },
      });
    });
  }

  /** Historique des règlements d'un livreur, le plus récent d'abord. */
  async listForDriver(driverId: string, page = 1, limit = 20) {
    const where = { driverId };
    const [rows, total] = await Promise.all([
      this.prisma.driverSettlement.findMany({
        where,
        orderBy: { paidAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.driverSettlement.count({ where }),
    ]);
    return { data: rows, meta: { page, limit, total } };
  }
}

/**
 * Première course couverte. Une course payable est soit livrée, soit échouée
 * sans faute du livreur (F3-05) : sa date est l'une ou l'autre.
 */
function periodStart(
  courses: ReadonlyArray<{ deliveredAt: Date | null; failedAt: Date | null }>,
): Date | null {
  const dates = courses
    .map((c) => c.deliveredAt ?? c.failedAt)
    .filter((d): d is Date => d != null)
    .map((d) => d.getTime());
  return dates.length ? new Date(Math.min(...dates)) : null;
}
