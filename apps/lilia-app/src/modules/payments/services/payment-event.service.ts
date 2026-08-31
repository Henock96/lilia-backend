import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentEventKind,
  PaymentEventOutcome,
  PaymentEventSource,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Journal des signaux reçus d'un prestataire — callbacks et réponses de
 * réconciliation, pour les encaissements comme pour les reversements.
 *
 * Écrit **avant** toute décision : même un signal qu'on refuse d'appliquer
 * (montant incohérent, transaction inconnue) laisse une trace. C'est ce qui
 * permet, trois semaines plus tard, de répondre à « le client dit avoir payé,
 * qu'avons-nous reçu et quand ? » — question à laquelle `Payment.metadata`, qui
 * est écrasé à chaque écriture, ne peut pas répondre.
 *
 * Table en écriture seule : aucun endpoint ne la modifie ni ne la supprime.
 */
@Injectable()
export class PaymentEventService {
  private readonly logger = new Logger(PaymentEventService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enregistre un signal.
   *
   * **Jamais bloquant.** Un journal en peine ne doit pas empêcher de confirmer
   * un paiement : l'argent a bougé, la commande doit avancer. L'échec est
   * remonté en `error` pour être visible dans Sentry.
   */
  async record(entry: {
    kind: PaymentEventKind;
    provider: string;
    externalId: string;
    source: PaymentEventSource;
    rawStatus: string;
    payload: unknown;
    paymentId?: string | null;
    payoutId?: string | null;
    outcome?: PaymentEventOutcome;
  }): Promise<string | null> {
    try {
      const event = await this.prisma.paymentEvent.create({
        data: {
          kind: entry.kind,
          provider: entry.provider,
          externalId: entry.externalId,
          source: entry.source,
          rawStatus: entry.rawStatus,
          payload: this.sanitize(entry.payload),
          paymentId: entry.paymentId ?? null,
          payoutId: entry.payoutId ?? null,
          outcome: entry.outcome ?? PaymentEventOutcome.APPLIED,
        },
        select: { id: true },
      });
      return event.id;
    } catch (error) {
      this.logger.error(
        `Journal prestataire non écrit — ${entry.kind}/${entry.provider}/${entry.rawStatus} : ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** Corrige l'issue une fois le traitement terminé. */
  async setOutcome(
    eventId: string | null,
    outcome: PaymentEventOutcome,
  ): Promise<void> {
    if (!eventId) return;
    await this.prisma.paymentEvent
      .update({ where: { id: eventId }, data: { outcome } })
      .catch((error) =>
        this.logger.error(
          `Issue du journal non mise à jour (${eventId}) : ${(error as Error).message}`,
        ),
      );
  }

  /**
   * Le signal a-t-il déjà été appliqué ?
   *
   * Complément — et non substitut — de l'`updateMany` conditionnel : celui-ci
   * reste la garantie d'idempotence, celle-ci sert à répondre `duplicate` sans
   * refaire tout le travail, et à mesurer le taux de rejeu en supervision.
   */
  async hasAppliedTerminal(
    provider: string,
    externalId: string,
  ): Promise<boolean> {
    const existing = await this.prisma.paymentEvent.findFirst({
      where: {
        provider,
        externalId,
        outcome: PaymentEventOutcome.APPLIED,
        rawStatus: { in: ['COMPLETED', 'FAILED'] },
      },
      select: { id: true },
    });
    return existing !== null;
  }

  /** Historique d'une transaction, le plus ancien d'abord (lecture ADMIN). */
  async listForPayment(paymentId: string) {
    return this.prisma.paymentEvent.findMany({
      where: { paymentId },
      orderBy: { receivedAt: 'asc' },
    });
  }

  async listForPayout(payoutId: string) {
    return this.prisma.paymentEvent.findMany({
      where: { payoutId },
      orderBy: { receivedAt: 'asc' },
    });
  }

  /**
   * Retire du payload ce qui n'a pas à être conservé.
   *
   * Le corps d'un callback ne porte ni jeton ni PIN — un prestataire mobile
   * money ne voit jamais le code secret du client, c'est tout l'intérêt du
   * dispositif. On coupe malgré tout par précaution les clés dont le nom évoque
   * un secret : le journal est consultable par les administrateurs, et un
   * changement de format côté prestataire ne doit pas y déverser un jeton.
   */
  private sanitize(payload: unknown): Prisma.InputJsonValue {
    if (payload === null || payload === undefined) return {};
    if (typeof payload !== 'object') return { value: String(payload) };

    const forbidden =
      /(token|secret|authorization|password|pin|apikey|api_key)/i;
    const walk = (value: unknown, depth: number): unknown => {
      if (depth > 6 || value === null || typeof value !== 'object')
        return value;
      if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        out[key] = forbidden.test(key) ? '[redacted]' : walk(val, depth + 1);
      }
      return out;
    };

    return walk(payload, 0) as Prisma.InputJsonValue;
  }
}
