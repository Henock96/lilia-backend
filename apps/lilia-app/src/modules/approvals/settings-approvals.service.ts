import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApiProperty, PickType } from '@nestjs/swagger';
import { ApprovalKind, Prisma } from '@prisma/client';
import { IsNumber, Max, Min, ValidateIf } from 'class-validator';

import { PrismaService } from '../../prisma/prisma.service';
import { UpdatePlatformSettingsDto } from '../platform-settings/dto/update-platform-settings.dto';
import {
  assertDeliveryPricingSwitch,
  describeFinancialChange,
  FINANCIAL_SETTING_KEYS,
  FinancialSettingKey,
  financialChanges,
  financialSnapshot,
  PlatformSettingsChangePayload,
} from '../platform-settings/financial-settings';
import {
  PlatformSettingsService,
  staleSettings,
} from '../platform-settings/platform-settings.service';
import { ApprovalsService } from './approvals.service';
import {
  PLATFORM_SETTINGS_REF,
  VendorCommissionChangePayload,
} from './settings-approvals';

/**
 * Corps de `POST /admin/platform-settings/financial-change` : les seuls
 * réglages financiers, avec **les mêmes bornes** que le PATCH (validateurs
 * hérités, pas recopiés), et l'`updatedAt` du formulaire chargé.
 */
export class FinancialSettingsChangeDto extends PickType(
  UpdatePlatformSettingsDto,
  [...FINANCIAL_SETTING_KEYS, 'expectedUpdatedAt'] as const,
) {}

/** Corps de `POST /admin/vendors/:id/commission-change`. */
export class VendorCommissionChangeDto {
  @ApiProperty({
    nullable: true,
    description:
      'Commission en % (0 à 50, deux décimales) ; `null` = taux plateforme.',
  })
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(50)
  commissionPercent!: number | null;
}

export interface SettingsApprovalRequested {
  approvalRequired: true;
  approval: Awaited<ReturnType<ApprovalsService['request']>>;
}

/**
 * R-09 — ouvre les demandes de changement d'un réglage qui fixe de l'argent.
 * Rien ne change avant qu'un second administrateur approuve
 * (`POST /admin/approvals/:id/approve`), qui applique le geste exact demandé.
 */
@Injectable()
export class SettingsApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly settings: PlatformSettingsService,
  ) {}

  async requestPlatformChange(
    dto: FinancialSettingsChangeDto,
    requestedBy: string,
  ): Promise<SettingsApprovalRequested> {
    // Obligatoire ici (facultatif sur le PATCH pour les back-offices
    // installés) : un second administrateur approuve ce que le premier a VU.
    if (!dto.expectedUpdatedAt) {
      throw new BadRequestException(
        'expectedUpdatedAt est requis : rechargez la configuration avant de demander un changement.',
      );
    }
    const current = await this.settings.readFreshSettings();
    if (
      new Date(dto.expectedUpdatedAt).getTime() !== current.updatedAt.getTime()
    ) {
      throw staleSettings();
    }

    const changes = financialChanges(current, dto as Record<string, unknown>);
    const keys = Object.keys(changes) as FinancialSettingKey[];
    if (keys.length === 0) {
      throw new BadRequestException(
        'Aucun réglage financier ne change : il n’y a rien à faire approuver.',
      );
    }
    await assertDeliveryPricingSwitch(
      this.prisma,
      current.deliveryPricingMode,
      changes.deliveryPricingMode as
        | typeof current.deliveryPricingMode
        | undefined,
    );

    const payload: PlatformSettingsChangePayload = {
      changes,
      before: financialSnapshot(current, keys),
    };
    const approval = await this.approvals.request({
      kind: ApprovalKind.PLATFORM_SETTINGS_CHANGE,
      refId: PLATFORM_SETTINGS_REF,
      payload: payload as unknown as Prisma.InputJsonValue,
      requestedBy,
      summary: describeFinancialChange(payload),
    });
    return { approvalRequired: true, approval };
  }

  async requestVendorCommissionChange(
    restaurantId: string,
    dto: VendorCommissionChangeDto,
    requestedBy: string,
  ): Promise<SettingsApprovalRequested> {
    if (dto.commissionPercent === undefined) {
      throw new BadRequestException(
        'commissionPercent est requis (un nombre, ou null pour le taux plateforme).',
      );
    }
    const vendor = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { nom: true, commissionPercent: true },
    });
    if (!vendor) throw new NotFoundException('Vendeur introuvable.');
    if (vendor.commissionPercent === dto.commissionPercent) {
      throw new BadRequestException(
        'La commission demandée est déjà celle du vendeur : il n’y a rien à faire approuver.',
      );
    }

    const payload: VendorCommissionChangePayload = {
      commissionPercent: dto.commissionPercent,
      before: vendor.commissionPercent,
    };
    const label = (v: number | null) =>
      v === null ? 'taux plateforme' : `${v} %`;
    const approval = await this.approvals.request({
      kind: ApprovalKind.VENDOR_COMMISSION_CHANGE,
      refId: restaurantId,
      payload: payload as unknown as Prisma.InputJsonValue,
      requestedBy,
      summary: `Commission de ${vendor.nom} : ${label(vendor.commissionPercent)} → ${label(dto.commissionPercent)}`,
    });
    return { approvalRequired: true, approval };
  }
}
