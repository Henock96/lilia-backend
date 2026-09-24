import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DeliveryTariffsService } from './delivery-tariffs.service';
import { DeliverySimulationService } from './delivery-simulation.service';
import { DeliveryTariffDraftDto } from './dto/delivery-tariff-draft.dto';

/**
 * Grille de livraison plateforme (F3-02) — ADMIN uniquement.
 *
 * Brouillon → publication. Une grille publiée ne se modifie plus : on en
 * publie une nouvelle, l'ancienne passe `RETIRED` dans la même transaction.
 */
@ApiTags('Delivery pricing')
@ApiBearerAuth()
@Controller('admin/delivery-tariffs')
@Roles('ADMIN')
export class AdminDeliveryTariffsController {
  constructor(
    private readonly tariffs: DeliveryTariffsService,
    private readonly simulation: DeliverySimulationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Toutes les versions de la grille, la plus récente d’abord',
  })
  async list() {
    return { data: await this.tariffs.list() };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return { data: await this.tariffs.findOne(id) };
  }

  @Post()
  @ApiOperation({ summary: 'Créer un brouillon de grille' })
  async create(
    @Body() dto: DeliveryTariffDraftDto,
    @CurrentUser() admin: User,
  ) {
    return { data: await this.tariffs.createDraft(dto, admin.id) };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Remplacer un brouillon (409 s’il est publié)' })
  async update(@Param('id') id: string, @Body() dto: DeliveryTariffDraftDto) {
    return { data: await this.tariffs.updateDraft(id, dto) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string) {
    await this.tariffs.deleteDraft(id);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publier un brouillon (retire la grille en vigueur)',
  })
  async publish(@Param('id') id: string, @CurrentUser() admin: User) {
    return {
      data: await this.tariffs.publish(id, admin.id),
      message: 'Grille publiée : elle s’applique aux prochaines commandes.',
    };
  }

  /**
   * Ce que la grille aurait facturé : rejeu des commandes livrées des 30
   * derniers jours et matrice vendeur → quartier. Lecture seule, n'importe
   * quelle version (un brouillon avant publication, la grille en vigueur pour
   * comparaison).
   */
  @Post(':id/simulate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Simuler une grille (rejeu 30 j + matrice)' })
  async simulate(@Param('id') id: string) {
    return { data: await this.simulation.simulateTariff(id) };
  }
}
