import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminCapability, User } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  FinancialSettingsChangeDto,
  SettingsApprovalsService,
  VendorCommissionChangeDto,
} from './settings-approvals.service';

/**
 * R-09 — demandes de changement des réglages qui fixent de l'argent.
 *
 * `FINANCE_EXECUTE` (donc MFA et authentification récente quand
 * `ADMIN_MFA_REQUIRED` est allumé) ; rien ne change avant l'approbation d'un
 * second administrateur `FINANCE_APPROVE`. Même contrat de réponse que les
 * autres gestes à deux (`approvalRequired`).
 */
@ApiTags('Approbations')
@ApiBearerAuth()
@Controller('admin')
@Roles('ADMIN')
export class SettingsApprovalsController {
  constructor(private readonly requests: SettingsApprovalsService) {}

  @Post('platform-settings/financial-change')
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Demander un changement de réglage financier (4 yeux)',
    description:
      'Frais de service, commission par défaut, points de fidélité, versements ' +
      'automatiques, tarification de la livraison. `expectedUpdatedAt` requis. ' +
      '409 `SETTINGS_STALE` si la configuration a changé depuis son chargement, ' +
      '`APPROVAL_ALREADY_PENDING` si une demande attend déjà.',
  })
  async requestPlatformChange(
    @Body() dto: FinancialSettingsChangeDto,
    @CurrentUser() admin: User,
  ) {
    return {
      data: await this.requests.requestPlatformChange(dto, admin.id),
      message:
        'Demande envoyée : un second administrateur doit l’approuver. Rien ne change d’ici là.',
    };
  }

  @Post('vendors/:id/commission-change')
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Demander un changement de commission d’un vendeur (4 yeux)',
  })
  async requestVendorCommissionChange(
    @Param('id') id: string,
    @Body() dto: VendorCommissionChangeDto,
    @CurrentUser() admin: User,
  ) {
    return {
      data: await this.requests.requestVendorCommissionChange(
        id,
        dto,
        admin.id,
      ),
      message:
        'Demande envoyée : un second administrateur doit approuver la nouvelle commission. Rien ne change d’ici là.',
    };
  }
}
