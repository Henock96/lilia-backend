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
import { IncidentsService } from './incidents.service';

@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Roles('ADMIN')
  @Post()
  async create(@Body() dto: CreateIncidentDto, @CurrentUser() user: User) {
    const incident = await this.incidents.create(dto, user.id);
    return { data: incident };
  }

  @Roles('ADMIN')
  @Get()
  async findAll(
    @Query('status') status?: IncidentStatus,
    @Query('severity') severity?: IncidentSeverity,
    @Query('type') type?: IncidentType,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.incidents.findAll({
      status,
      severity,
      type,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
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
