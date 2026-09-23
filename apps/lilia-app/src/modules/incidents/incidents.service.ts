import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Incident,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  OrderStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { UpdateIncidentDto } from './dto/update-incident.dto';
import {
  CustomerIssueKind,
  ReportOrderIssueDto,
} from './dto/report-order-issue.dto';

export interface IncidentCreatedEvent {
  incidentId: string;
  type: IncidentType;
  severity: IncidentSeverity;
  orderId?: string | null;
  riderId?: string | null;
  restaurantId?: string | null;
}

export interface IncidentUpdatedEvent {
  incidentId: string;
  status: IncidentStatus;
  resolution?: string | null;
}

@Injectable()
export class IncidentsService {
  private readonly logger = new Logger(IncidentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateIncidentDto, reportedBy?: string): Promise<Incident> {
    const incident = await this.prisma.incident.create({
      data: {
        type: dto.type,
        severity: dto.severity ?? IncidentSeverity.MEDIUM,
        title: dto.title,
        description: dto.description,
        orderId: dto.orderId ?? null,
        riderId: dto.riderId ?? null,
        restaurantId: dto.restaurantId ?? null,
        reportedBy: reportedBy ?? null,
        metadata: (dto.metadata ?? null) as any,
      },
    });

    this.logger.log(`Incident créé: ${incident.id} (${incident.type})`);
    this.eventEmitter.emit('incident.created', {
      incidentId: incident.id,
      type: incident.type,
      severity: incident.severity,
      orderId: incident.orderId,
      riderId: incident.riderId,
      restaurantId: incident.restaurantId,
    } satisfies IncidentCreatedEvent);

    return incident;
  }

  async findAll(params: {
    status?: IncidentStatus;
    severity?: IncidentSeverity;
    type?: IncidentType;
    limit?: number;
    offset?: number;
  }): Promise<{ data: Incident[]; total: number }> {
    const { status, severity, type, limit = 50, offset = 0 } = params;
    const where = {
      ...(status && { status }),
      ...(severity && { severity }),
      ...(type && { type }),
    };

    const [data, total] = await Promise.all([
      this.prisma.incident.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.incident.count({ where }),
    ]);

    return { data, total };
  }

  async findOne(id: string): Promise<Incident> {
    const incident = await this.prisma.incident.findUnique({ where: { id } });
    if (!incident) throw new NotFoundException(`Incident ${id} introuvable`);
    return incident;
  }

  async update(
    id: string,
    dto: UpdateIncidentDto,
    resolvedBy?: string,
  ): Promise<Incident> {
    await this.findOne(id);

    const isResolved =
      dto.status === IncidentStatus.RESOLVED ||
      dto.status === IncidentStatus.CLOSED;

    const incident = await this.prisma.incident.update({
      where: { id },
      data: {
        ...(dto.status && { status: dto.status }),
        ...(dto.severity && { severity: dto.severity }),
        ...(dto.resolution !== undefined && { resolution: dto.resolution }),
        ...(isResolved && { resolvedAt: new Date(), resolvedBy }),
      },
    });

    this.eventEmitter.emit('incident.updated', {
      incidentId: incident.id,
      status: incident.status,
      resolution: incident.resolution,
    } satisfies IncidentUpdatedEvent);

    return incident;
  }

  /**
   * Le client signale un problème sur SA commande (Master Audit v1, F-06).
   *
   * C'est le recours qui manquait : une commande déclarée livrée sans l'être
   * n'avait aucune porte de sortie dans l'application. L'incident porte tout
   * ce qu'il faut pour instruire — la façon dont la remise a été attestée
   * (`CODE`, `UNVERIFIED`, `ADMIN_OVERRIDE`), le livreur, l'horodatage — et
   * part vers les administrateurs par le canal existant (`incident.created`).
   *
   * Un seul signalement ouvert par commande : le client qui insiste enrichit
   * le même dossier au lieu d'en ouvrir dix.
   */
  async reportByCustomer(
    orderId: string,
    userId: string,
    dto: ReportOrderIssueDto,
  ): Promise<Incident> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        status: true,
        restaurantId: true,
        updatedAt: true,
        delivery: {
          select: {
            id: true,
            delivererId: true,
            deliveredAt: true,
            handoverMethod: true,
            handoverVerifiedAt: true,
          },
        },
      },
    });
    // Même réponse pour « inexistante » et « pas à vous » : pas d'oracle.
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Commande introuvable.');
    }
    if (!REPORTABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        'Cette commande ne peut pas faire l’objet d’un signalement dans son état actuel.',
      );
    }
    const closedAt = order.delivery?.deliveredAt ?? order.updatedAt;
    if (
      order.status === OrderStatus.LIVRER &&
      Date.now() - closedAt.getTime() > REPORT_WINDOW_MS
    ) {
      throw new BadRequestException(
        'Le délai de signalement (72 h après la livraison) est dépassé. Contactez le support.',
      );
    }

    const existing = await this.prisma.incident.findFirst({
      where: {
        orderId,
        reportedBy: userId,
        status: { in: [IncidentStatus.OPEN, IncidentStatus.IN_PROGRESS] },
      },
    });
    if (existing) return existing;

    const kind = dto.kind;
    return this.create(
      {
        type:
          kind === 'NOT_RECEIVED' || kind === 'WRONG_ORDER'
            ? IncidentType.WRONG_DELIVERY
            : kind === 'LATE'
              ? IncidentType.ORDER_DELAYED
              : IncidentType.CUSTOMER_COMPLAINT,
        // Une commande payée et jamais reçue est une dette : HIGH.
        severity:
          kind === 'NOT_RECEIVED'
            ? IncidentSeverity.HIGH
            : IncidentSeverity.MEDIUM,
        title: CUSTOMER_ISSUE_TITLES[kind],
        description: dto.message?.trim() || CUSTOMER_ISSUE_TITLES[kind],
        orderId,
        riderId: order.delivery?.delivererId ?? undefined,
        restaurantId: order.restaurantId,
        metadata: {
          source: 'CUSTOMER',
          kind,
          orderStatus: order.status,
          deliveryId: order.delivery?.id ?? null,
          handoverMethod: order.delivery?.handoverMethod ?? null,
          handoverVerifiedAt:
            order.delivery?.handoverVerifiedAt?.toISOString() ?? null,
        },
      } as CreateIncidentDto,
      userId,
    );
  }
}

const REPORTABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PAYER,
  OrderStatus.ACCEPTEE, // F3-01
  OrderStatus.EN_PREPARATION,
  OrderStatus.PRET,
  OrderStatus.EN_ROUTE,
  OrderStatus.LIVRER,
  // F3-05 : un client doit pouvoir contester l'issue d'un échec de livraison.
  OrderStatus.ECHEC_LIVRAISON,
];

/** Fenêtre de signalement après livraison. */
const REPORT_WINDOW_MS = 72 * 3_600_000;

const CUSTOMER_ISSUE_TITLES: Record<CustomerIssueKind, string> = {
  NOT_RECEIVED: 'Client : commande déclarée livrée mais non reçue',
  WRONG_ORDER: 'Client : commande reçue erronée ou incomplète',
  LATE: 'Client : commande très en retard',
  OTHER: 'Client : problème signalé sur une commande',
};
