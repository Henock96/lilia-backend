import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  User,
} from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { UpdateIncidentDto } from './dto/update-incident.dto';
import { IncidentListQueryDto } from './dto/incident-list-query.dto';
import { IncidentsService } from './incidents.service';
import { ReportOrderIssueDto } from './dto/report-order-issue.dto';
import { Throttle } from '@nestjs/throttler';

@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  /**
   * Le client signale un problème sur sa commande (F-06). Déclaré AVANT
   * `@Post()` n'est pas nécessaire (chemins distincts), mais la route vit ici
   * pour que tout incident naisse au même endroit.
   */
  @Roles('CLIENT')
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 5, ttl: 60000 } })
  @Post('orders/:orderId/report')
  async reportOrderIssue(
    @Param('orderId') orderId: string,
    @Body() dto: ReportOrderIssueDto,
    @CurrentUser() user: User,
  ) {
    const incident = await this.incidents.reportByCustomer(
      orderId,
      user.id,
      dto,
    );
    // Le client n'a pas à voir les métadonnées d'instruction.
    return {
      data: {
        id: incident.id,
        status: incident.status,
        createdAt: incident.createdAt,
      },
      message: 'Signalement transmis. Notre équipe vous recontacte rapidement.',
    };
  }

  @Roles('ADMIN')
  @Post()
  async create(@Body() dto: CreateIncidentDto, @CurrentUser() user: User) {
    const incident = await this.incidents.create(dto, user.id);
    return { data: incident };
  }

  @Roles('ADMIN')
  @Get()
  async findAll(
    @Query() query: IncidentListQueryDto,
    @Query('status') status?: IncidentStatus,
    @Query('severity') severity?: IncidentSeverity,
    @Query('type') type?: IncidentType,
  ) {
    return this.incidents.findAll({
      status,
      severity,
      type,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Roles('ADMIN')
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const incident = await this.incidents.findOne(id);
    return { data: incident };
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateIncidentDto,
    @CurrentUser() user: User,
  ) {
    const incident = await this.incidents.update(id, dto, user.id);
    return { data: incident };
  }
}
