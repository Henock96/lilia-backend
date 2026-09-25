import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminCapability,
  ApprovalKind,
  ApprovalStatus,
  User,
} from '@prisma/client';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ApprovalsService } from './approvals.service';

export class ListApprovalsQueryDto {
  @IsOptional()
  @IsEnum(ApprovalStatus)
  status?: ApprovalStatus;
}

export class RejectApprovalDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

export class UpdateCapabilitiesDto {
  @IsArray()
  @ArrayUnique()
  @IsEnum(AdminCapability, { each: true })
  capabilities!: AdminCapability[];
}

/**
 * F3-08 — file des gestes financiers à deux administrateurs.
 *
 * Le demandeur voit sa demande mais ne peut pas l'approuver (le service le
 * refuse, et la base aussi). Approuver EXÉCUTE le geste.
 */
@ApiTags('Approbations')
@ApiBearerAuth()
@Controller('admin')
@Roles('ADMIN')
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('approvals')
  @ApiOperation({
    summary: 'Demandes d’approbation (les plus récentes d’abord)',
  })
  async list(@Query() query: ListApprovalsQueryDto) {
    return { data: await this.approvals.list(query.status) };
  }

  @Post('approvals/:id/approve')
  @RequireCapability(AdminCapability.FINANCE_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approuver — et exécuter — un geste demandé par un autre admin',
  })
  async approve(@Param('id') id: string, @CurrentUser() admin: User) {
    return { data: await this.approvals.approve(id, admin.id) };
  }

  /** Refuser (autre admin) ou retirer sa propre demande (demandeur). */
  @Post('approvals/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refuser une demande, ou retirer la sienne' })
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectApprovalDto,
    @CurrentUser() admin: User,
  ) {
    return { data: await this.approvals.reject(id, admin.id, dto.reason) };
  }

  /** Les administrateurs et leurs capacités. */
  @Get('admins')
  @ApiOperation({ summary: 'Administrateurs et capacités' })
  async admins() {
    return {
      data: await this.prisma.user.findMany({
        where: { role: 'ADMIN' },
        select: { id: true, nom: true, email: true, adminCapabilities: true },
        orderBy: { createdAt: 'asc' },
      }),
    };
  }

  /**
   * Attribuer ou retirer des capacités : TOUJOURS à deux (D7). Rend la
   * demande ; rien ne change avant l'approbation d'un autre administrateur.
   */
  @Patch('users/:id/capabilities')
  @RequireCapability(AdminCapability.USER_ROLES)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Demander un changement de capacités (4 yeux)' })
  async requestCapabilities(
    @Param('id') id: string,
    @Body() dto: UpdateCapabilitiesDto,
    @CurrentUser() admin: User,
  ) {
    const capabilities = [...dto.capabilities].sort();
    const approval = await this.approvals.request({
      kind: ApprovalKind.CAPABILITY_GRANT,
      refId: id,
      payload: { capabilities },
      requestedBy: admin.id,
      summary: `Capacités d’un administrateur : ${capabilities.join(', ') || 'aucune'}`,
    });
    return {
      data: { approvalRequired: true, approval },
      message:
        'Demande envoyée : un second administrateur doit l’approuver avant que les capacités changent.',
    };
  }
}
