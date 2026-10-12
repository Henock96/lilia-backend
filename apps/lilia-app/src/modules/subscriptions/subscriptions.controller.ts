import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminCapability, User } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  GrantSubscriptionDto,
  RevokeSubscriptionDto,
} from './dto/subscription.dto';
import { VendorSubscriptionService } from './vendor-subscription.service';

/** Borne de l'en-tête `Idempotency-Key` (un UUID en fait 36). */
const MAX_REQUEST_KEY_LENGTH = 200;

/**
 * Premium (Lot 2) — abonnements vendeur, **côté administration**.
 *
 * Enregistrer ou révoquer une période fixe ce qu'un vendeur a payé :
 * `FINANCE_EXECUTE` (décision du 11/10/2026 : un seul administrateur, pas de
 * quatre yeux), MFA appliquée par `AdminSecurityGuard` quand elle est exigée.
 * Chaque geste est tracé dans `AdminAuditLog`, dans la transaction du geste.
 */
@ApiTags('Abonnements (admin)')
@ApiBearerAuth()
@Controller('admin/vendors/:vendorId/subscriptions')
@Roles('ADMIN')
export class AdminVendorSubscriptionsController {
  constructor(private readonly subscriptions: VendorSubscriptionService) {}

  @Get()
  @ApiOperation({ summary: 'Historique des périodes et statut Premium' })
  async list(@Param('vendorId') vendorId: string) {
    return { data: await this.subscriptions.listForVendor(vendorId) };
  }

  /**
   * Enregistre un mois **déjà payé**. `Idempotency-Key` obligatoire : un
   * double clic rend la même période au lieu d'en créer une seconde.
   */
  @Throttle({ short: { limit: 1, ttl: 2000 }, long: { limit: 30, ttl: 60000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Enregistrer un mois d’abonnement payé' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  async grant(
    @Param('vendorId') vendorId: string,
    @Body() dto: GrantSubscriptionDto,
    @CurrentUser() admin: User,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const requestKey = idempotencyKey?.trim();
    if (!requestKey || requestKey.length > MAX_REQUEST_KEY_LENGTH) {
      throw new BadRequestException(
        'En-tête Idempotency-Key requis (une valeur par enregistrement).',
      );
    }

    // L'audit est écrit par le service, dans la transaction de la période.
    const { subscription, replayed } = await this.subscriptions.grant({
      restaurantId: vendorId,
      adminId: admin.id,
      requestKey,
      paymentMethod: dto.paymentMethod,
      paymentReference: dto.paymentReference,
      note: dto.note,
    });

    return {
      data: subscription,
      message: replayed
        ? 'Cette période était déjà enregistrée.'
        : 'Mois d’abonnement enregistré.',
    };
  }

  @Post(':subscriptionId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Révoquer une période d’abonnement' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  async revoke(
    @Param('vendorId') vendorId: string,
    @Param('subscriptionId') subscriptionId: string,
    @Body() dto: RevokeSubscriptionDto,
    @CurrentUser() admin: User,
  ) {
    // Révocation et audit dans la même transaction (service).
    const subscription = await this.subscriptions.revoke(
      vendorId,
      subscriptionId,
      admin.id,
      dto.reason,
    );

    return { data: subscription, message: 'Période révoquée.' };
  }
}

/**
 * Premium (Lot 2) — le statut du vendeur connecté. Verdict serveur : les
 * applications l'affichent, elles ne le recalculent jamais (règle 2).
 */
@ApiTags('Abonnements')
@ApiBearerAuth()
@Controller('vendors/me/subscription')
@Roles('RESTAURATEUR')
export class VendorSubscriptionController {
  constructor(private readonly subscriptions: VendorSubscriptionService) {}

  @Get()
  @ApiOperation({ summary: 'Mon statut Premium et mes droits' })
  async mine(@CurrentUser() user: User) {
    return { data: await this.subscriptions.verdictForOwner(user.id) };
  }
}
