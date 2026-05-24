import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  Role,
  StatusUser,
} from '@prisma/client';
import * as Sentry from '@sentry/nestjs';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type {
  IncidentCreatedEvent,
  IncidentUpdatedEvent,
} from './incidents.service';

/**
 * Notifie les admins en temps réel des incidents qui demandent une action,
 * et trace tous les incidents dans Sentry pour observabilité.
 *
 * Stratégie (a remplacé l'ancien export Notion) :
 *   - CRITICAL → Sentry.captureMessage(level='error') + FCM push à tous les admins
 *   - HIGH     → FCM push à tous les admins + breadcrumb Sentry
 *   - MEDIUM / LOW → breadcrumb Sentry uniquement (pas de spam push)
 *   - Résolution (status RESOLVED/CLOSED) → breadcrumb info
 *
 * On évite l'email digest dans ce listener : l'admin consultera `/incidents`
 * pour la vue d'ensemble. Un digest quotidien Mailtrap pourra être ajouté via
 * un cron dédié si le volume LOW/MEDIUM le justifie.
 */
@Injectable()
export class IncidentsNotificationListener {
  private readonly logger = new Logger(IncidentsNotificationListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent('incident.created')
  async onIncidentCreated(event: IncidentCreatedEvent): Promise<void> {
    const sentryLevel = severityToSentryLevel(event.severity);
    Sentry.addBreadcrumb({
      category: 'incident',
      type: 'default',
      level: sentryLevel,
      message: `Incident créé — ${event.type} (${event.severity})`,
      data: {
        incidentId: event.incidentId,
        type: event.type,
        severity: event.severity,
        orderId: event.orderId ?? undefined,
        riderId: event.riderId ?? undefined,
        restaurantId: event.restaurantId ?? undefined,
      },
    });

    // CRITICAL : alerte Sentry visible dans la dashboard Issues + alerting Slack
    // (cf. règles Sentry configurées en LFD-4).
    if (event.severity === IncidentSeverity.CRITICAL) {
      Sentry.captureMessage(
        `Incident CRITICAL ${event.type} — ${event.incidentId}`,
        {
          level: 'error',
          tags: {
            incidentType: event.type,
            incidentSeverity: event.severity,
          },
          extra: {
            incidentId: event.incidentId,
            orderId: event.orderId,
            riderId: event.riderId,
            restaurantId: event.restaurantId,
          },
        },
      );
    }

    if (
      event.severity === IncidentSeverity.HIGH ||
      event.severity === IncidentSeverity.CRITICAL
    ) {
      await this.pushToAllAdmins(
        formatIncidentTitle(event.severity, event.type),
        formatIncidentBody(event),
        {
          type: 'incident',
          incidentId: event.incidentId,
          severity: event.severity,
          incidentType: event.type,
          ...(event.orderId && { orderId: event.orderId }),
          ...(event.restaurantId && { restaurantId: event.restaurantId }),
        },
      );
    }
  }

  @OnEvent('incident.updated')
  onIncidentUpdated(event: IncidentUpdatedEvent): void {
    Sentry.addBreadcrumb({
      category: 'incident',
      type: 'default',
      level: 'info',
      message: `Incident mis à jour — ${event.status}`,
      data: {
        incidentId: event.incidentId,
        status: event.status,
        resolution: event.resolution ?? undefined,
      },
    });

    if (
      event.status === IncidentStatus.RESOLVED ||
      event.status === IncidentStatus.CLOSED
    ) {
      this.logger.log(
        `Incident ${event.incidentId} résolu (${event.status})${
          event.resolution ? ` — ${event.resolution}` : ''
        }`,
      );
    }
  }

  /**
   * Push FCM en parallèle à tous les admins ACTIVE.
   * On utilise `allSettled` pour qu'un device offline n'empêche pas de
   * notifier les autres. Les tokens invalides sont déjà nettoyés en interne
   * par `NotificationsService.sendPushNotification`.
   */
  private async pushToAllAdmins(
    title: string,
    body: string,
    data: Record<string, string>,
  ): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: Role.ADMIN, statusUser: StatusUser.ACTIVE },
      select: { id: true },
    });

    if (admins.length === 0) {
      this.logger.warn(
        'Aucun admin ACTIVE trouvé pour notifier — incident non poussé',
      );
      return;
    }

    const results = await Promise.allSettled(
      admins.map((a) =>
        this.notifications.sendPushNotification(a.id, title, body, data),
      ),
    );

    const failures = results.filter((r) => r.status === 'rejected').length;
    if (failures > 0) {
      this.logger.warn(
        `FCM admins : ${failures}/${admins.length} échecs (les autres push sont partis)`,
      );
    }
  }
}

function severityToSentryLevel(
  severity: IncidentSeverity,
): Sentry.SeverityLevel {
  switch (severity) {
    case IncidentSeverity.CRITICAL:
      return 'error';
    case IncidentSeverity.HIGH:
      return 'warning';
    case IncidentSeverity.MEDIUM:
      return 'info';
    case IncidentSeverity.LOW:
      return 'debug';
  }
}

const SEVERITY_EMOJI: Record<IncidentSeverity, string> = {
  CRITICAL: '🚨',
  HIGH: '⚠️',
  MEDIUM: 'ℹ️',
  LOW: '·',
};

const TYPE_LABELS: Record<IncidentType, string> = {
  ORDER_CANCELLED: 'Commande annulée',
  ORDER_DELAYED: 'Retard de livraison',
  PAYMENT_FAILED: 'Échec paiement',
  DRIVER_NO_SHOW: 'Livreur absent',
  DRIVER_ACCIDENT: 'Accident livreur',
  CUSTOMER_COMPLAINT: 'Plainte client',
  RESTAURANT_CLOSED: 'Restaurant fermé',
  STOCK_ISSUE: 'Problème de stock',
  WRONG_DELIVERY: 'Mauvaise livraison',
  REFUND_REQUEST: 'Demande de remboursement',
  OTHER: 'Incident',
};

function formatIncidentTitle(
  severity: IncidentSeverity,
  type: IncidentType,
): string {
  return `${SEVERITY_EMOJI[severity]} ${TYPE_LABELS[type]}`;
}

function formatIncidentBody(event: IncidentCreatedEvent): string {
  const refs: string[] = [];
  if (event.orderId) refs.push(`commande #${event.orderId.slice(-6)}`);
  if (event.restaurantId) refs.push(`resto ${event.restaurantId.slice(-6)}`);
  if (event.riderId) refs.push(`livreur ${event.riderId.slice(-6)}`);
  const suffix = refs.length > 0 ? ` — ${refs.join(', ')}` : '';
  return `Sévérité ${event.severity}${suffix}. Ouvrir l'admin pour traiter.`;
}
