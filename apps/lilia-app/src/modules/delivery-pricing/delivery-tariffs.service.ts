import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface TariffDraftInput {
  roadFactor: number;
  bands: Array<{ maxKm: number; feeXaf: number }>;
  overrides?: Array<{
    originQuartierId: string;
    destQuartierId: string;
    feeXaf: number;
  }>;
  note?: string | null;
}

/**
 * Règles qu'une grille doit respecter pour avoir un sens. Les bornes de
 * chaque champ (entiers, positifs, plafonds) sont portées par le DTO ; ici,
 * ce qui ne se voit qu'en regardant les lignes ensemble.
 */
export function tariffDraftViolations(draft: TariffDraftInput): string[] {
  const violations: string[] = [];

  const seenKm = new Set<number>();
  for (const band of draft.bands) {
    if (seenKm.has(band.maxKm)) {
      violations.push(
        `Deux tranches s'arrêtent à ${band.maxKm} km : le prix serait ambigu.`,
      );
    }
    seenKm.add(band.maxKm);
  }

  const seenPairs = new Set<string>();
  for (const o of draft.overrides ?? []) {
    const pair = `${o.originQuartierId} → ${o.destQuartierId}`;
    if (seenPairs.has(pair)) {
      violations.push(`La paire ${pair} est surchargée deux fois.`);
    }
    seenPairs.add(pair);
  }

  return violations;
}

const TARIFF_DETAIL = {
  bands: { orderBy: { maxKm: 'asc' } },
  overrides: {
    orderBy: [{ originQuartierId: 'asc' }, { destQuartierId: 'asc' }],
  },
} satisfies Prisma.DeliveryTariffInclude;

/**
 * Grille de livraison versionnée (F3-02) — vue administrateur.
 *
 * Une version publiée est **immuable** : chaque commande fige son numéro
 * (`Order.deliveryTariffVersion`). La modifier après coup ferait mentir le
 * prix de toutes les commandes passées sous elle. On ne corrige donc pas une
 * grille publiée : on en publie une nouvelle, et l'ancienne passe `RETIRED`.
 *
 * Au plus une grille `PUBLISHED` : c'est l'index unique partiel
 * `DeliveryTariff_one_published_uq` qui le garantit, pas ce service.
 */
@Injectable()
export class DeliveryTariffsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.deliveryTariff.findMany({
      orderBy: { version: 'desc' },
      include: TARIFF_DETAIL,
    });
  }

  async findOne(id: string) {
    const tariff = await this.prisma.deliveryTariff.findUnique({
      where: { id },
      include: TARIFF_DETAIL,
    });
    if (!tariff) throw new NotFoundException('Grille introuvable.');
    return tariff;
  }

  async createDraft(dto: TariffDraftInput, actorId: string) {
    await this.assertValid(dto);
    const { _max } = await this.prisma.deliveryTariff.aggregate({
      _max: { version: true },
    });
    try {
      return await this.prisma.deliveryTariff.create({
        data: {
          version: (_max.version ?? 0) + 1,
          status: 'DRAFT',
          roadFactor: dto.roadFactor,
          note: dto.note ?? null,
          createdBy: actorId,
          bands: { createMany: { data: dto.bands } },
          overrides: { createMany: { data: dto.overrides ?? [] } },
        },
        include: TARIFF_DETAIL,
      });
    } catch (error) {
      // Deux administrateurs créent un brouillon au même instant : ils ont lu
      // le même dernier numéro. `version @unique` départage.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          "Une autre grille vient d'être créée au même moment. Réessayez.",
        );
      }
      throw error;
    }
  }

  async updateDraft(id: string, dto: TariffDraftInput) {
    await this.assertDraft(id);
    await this.assertValid(dto);

    await this.prisma.$transaction(async (tx) => {
      // Conditionnel : si la grille a été publiée entre la lecture et
      // l'écriture, on ne réécrit pas une version désormais figée.
      const { count } = await tx.deliveryTariff.updateMany({
        where: { id, status: 'DRAFT' },
        data: { roadFactor: dto.roadFactor, note: dto.note ?? null },
      });
      if (count === 0) throw publishedMeanwhile();
      await tx.deliveryTariffBand.deleteMany({ where: { tariffId: id } });
      await tx.deliveryTariffOverride.deleteMany({ where: { tariffId: id } });
      await tx.deliveryTariffBand.createMany({
        data: dto.bands.map((b) => ({ ...b, tariffId: id })),
      });
      await tx.deliveryTariffOverride.createMany({
        data: (dto.overrides ?? []).map((o) => ({ ...o, tariffId: id })),
      });
    });
    return this.findOne(id);
  }

  async deleteDraft(id: string) {
    await this.assertDraft(id);
    const { count } = await this.prisma.deliveryTariff.deleteMany({
      where: { id, status: 'DRAFT' },
    });
    if (count === 0) throw publishedMeanwhile();
  }

  /**
   * Publication atomique : l'ancienne grille passe `RETIRED`, le brouillon
   * `PUBLISHED`, et l'audit est écrit — les trois ou rien.
   *
   * L'audit est écrit **dans** la transaction, pas après : une grille publiée
   * change le prix de toutes les commandes suivantes et la paie de tous les
   * livreurs, elle ne peut pas exister sans sa trace (règle R8).
   */
  async publish(id: string, actorId: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const draft = await tx.deliveryTariff.findUnique({
          where: { id },
          select: {
            id: true,
            version: true,
            status: true,
            _count: { select: { bands: true } },
          },
        });
        if (!draft) throw new NotFoundException('Grille introuvable.');
        if (draft.status !== 'DRAFT') {
          throw new ConflictException(
            'Seul un brouillon peut être publié. Une grille publiée ou retirée ne change plus.',
          );
        }
        if (draft._count.bands === 0) {
          throw new BadRequestException(
            'Une grille sans tranche ne peut pas être publiée.',
          );
        }

        // Retirer d'abord : l'index unique partiel refuserait deux grilles
        // PUBLISHED, même un instant.
        await tx.deliveryTariff.updateMany({
          where: { status: 'PUBLISHED' },
          data: { status: 'RETIRED' },
        });
        const { count } = await tx.deliveryTariff.updateMany({
          where: { id, status: 'DRAFT' },
          data: {
            status: 'PUBLISHED',
            publishedAt: new Date(),
            publishedBy: actorId,
          },
        });
        if (count === 0) throw publishedMeanwhile();

        await tx.adminAuditLog.create({
          data: {
            actorId,
            action: AdminAuditAction.DELIVERY_TARIFF_PUBLISHED,
            targetType: 'DeliveryTariff',
            targetId: id,
            metadata: { version: draft.version },
          },
        });
      });
    } catch (error) {
      // Deux brouillons publiés au même instant : chacun a retiré « la »
      // grille publiée qu'il voyait, et l'index unique partiel refuse le
      // second. Toute sa transaction est annulée.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Une autre grille vient d’être publiée au même moment. Rechargez avant de réessayer.',
        );
      }
      throw error;
    }
    return this.findOne(id);
  }

  private async assertDraft(id: string) {
    const tariff = await this.prisma.deliveryTariff.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!tariff) throw new NotFoundException('Grille introuvable.');
    if (tariff.status !== 'DRAFT') throw publishedMeanwhile();
  }

  private async assertValid(dto: TariffDraftInput) {
    const violations = tariffDraftViolations(dto);
    if (violations.length > 0) {
      throw new BadRequestException(violations.join(' '));
    }

    const quartierIds = new Set(
      (dto.overrides ?? []).flatMap((o) => [
        o.originQuartierId,
        o.destQuartierId,
      ]),
    );
    if (quartierIds.size === 0) return;
    const known = await this.prisma.quartier.count({
      where: { id: { in: [...quartierIds] } },
    });
    if (known !== quartierIds.size) {
      throw new BadRequestException(
        'Une surcharge vise un quartier inconnu. Rechargez la liste des quartiers.',
      );
    }
  }
}

function publishedMeanwhile() {
  return new ConflictException(
    'Cette grille n’est plus un brouillon : une grille publiée ne se modifie pas, publiez-en une nouvelle.',
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
