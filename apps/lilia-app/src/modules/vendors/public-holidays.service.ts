import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** « AAAA-MM-JJ » → minuit UTC, la représentation d'une colonne `@db.Date`. */
export function holidayDate(iso: string): Date {
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (
    !ISO_DATE.test(iso) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== iso
  ) {
    throw new BadRequestException('Date attendue au format AAAA-MM-JJ.');
  }
  return date;
}

/**
 * Calendrier des jours fériés (F3-03, R-03.5). Aucun jour n'est semé : la
 * liste officielle se saisit, elle ne se devine pas (fêtes mobiles, jours
 * décrétés). Tant qu'elle est vide, `closedOnHolidays` n'a aucun effet.
 */
@Injectable()
export class PublicHolidaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  /** Depuis le 1er janvier de l'année en cours. */
  list() {
    const year = new Date().getUTCFullYear();
    return this.prisma.publicHoliday.findMany({
      where: { date: { gte: new Date(`${year}-01-01T00:00:00.000Z`) } },
      orderBy: { date: 'asc' },
    });
  }

  async create(iso: string, label: string, actorId: string) {
    const date = holidayDate(iso);
    try {
      const holiday = await this.prisma.publicHoliday.create({
        data: { date, label: label.trim() },
      });
      await this.audit.record({
        actorId,
        action: AdminAuditAction.PUBLIC_HOLIDAY_UPDATED,
        targetType: 'PublicHoliday',
        targetId: iso,
        metadata: { op: 'create', label: holiday.label },
      });
      return holiday;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ce jour est déjà férié.');
      }
      throw error;
    }
  }

  async remove(iso: string, actorId: string) {
    const date = holidayDate(iso);
    const { count } = await this.prisma.publicHoliday.deleteMany({
      where: { date },
    });
    if (count === 0) throw new NotFoundException("Ce jour n'est pas férié.");
    await this.audit.record({
      actorId,
      action: AdminAuditAction.PUBLIC_HOLIDAY_UPDATED,
      targetType: 'PublicHoliday',
      targetId: iso,
      metadata: { op: 'delete' },
    });
  }
}
