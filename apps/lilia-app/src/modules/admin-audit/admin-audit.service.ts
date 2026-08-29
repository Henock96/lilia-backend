import { Injectable, Logger } from '@nestjs/common';
import { AdminAuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AdminAuditEntry {
  actorId: string;
  action: AdminAuditAction;
  targetType: 'User' | 'Restaurant' | 'Payment' | 'Order';
  targetId: string;
  reason?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Journal d'audit des actions d'administration (audit du 28/08/2026).
 *
 * Changer un rôle, bannir un compte, suspendre un vendeur ou confirmer un
 * paiement ne laissait qu'une ligne de log applicatif : perdue à la rotation,
 * non interrogeable, et sans valeur en cas de litige. On écrit désormais une
 * ligne durable par action sensible.
 *
 * **Jamais bloquant** : une écriture d'audit qui échoue ne doit pas annuler
 * l'action d'administration elle-même (débannir quelqu'un doit rester possible
 * même si la table d'audit est en peine). L'échec est loggué en `error` pour
 * être visible dans Sentry.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AdminAuditEntry): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          actorId: entry.actorId,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          reason: entry.reason ?? null,
          metadata: entry.metadata,
        },
      });
    } catch (error) {
      this.logger.error(
        `Journal d'audit non écrit — action ${entry.action} sur ${entry.targetType}:${entry.targetId} par ${entry.actorId} : ${(error as Error).message}`,
      );
    }
  }

  /** Consultation du journal (ADMIN) — le plus récent d'abord. */
  async list(params: {
    page?: number;
    limit?: number;
    action?: AdminAuditAction;
    targetId?: string;
  }) {
    const page = params.page ?? 1;
    const limit = params.limit ?? 50;
    const where: Prisma.AdminAuditLogWhereInput = {
      ...(params.action ? { action: params.action } : {}),
      ...(params.targetId ? { targetId: params.targetId } : {}),
    };

    const [logs, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          actor: { select: { id: true, nom: true, email: true } },
        },
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    return { data: logs, meta: { page, limit, total } };
  }
}
