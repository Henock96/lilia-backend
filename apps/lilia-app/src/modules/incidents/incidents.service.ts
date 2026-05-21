import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Incident,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { UpdateIncidentDto } from './dto/update-incident.dto';

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

  async create(
    dto: CreateIncidentDto,
    reportedBy?: string,
  ): Promise<Incident> {
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
}
