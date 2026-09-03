import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { User } from '@prisma/client';

import { VendorOnboardingService } from './vendor-onboarding.service';
import { VendorInvitationService } from './vendor-invitation.service';
import { VendorsService } from './vendors.service';
import { RestaurantHoursService } from '../restaurants/restaurant-hours.service';
import { RestaurantAccessService } from '../restaurants/restaurant-access.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  ActivateVendorDto,
  CreateVendorOnboardingDto,
  UpdateVendorCommerceDto,
  UpdateVendorDeliveryDto,
  UpdateVendorHoursDto,
  UpdateVendorIdentityDto,
  UpdateVendorLocationDto,
} from './dto/onboarding.dto';
import {
  UpdateDisplayOrderDto,
  UpdateFeaturedDto,
} from './dto/vendor-showcase.dto';

/**
 * Onboarding vendeur — configuration partagée entre l'administrateur et le
 * vendeur lui-même.
 *
 * Le vendeur reçoit son accès dès la création : il peut donc remplir ses
 * horaires, ses photos et son catalogue en parallèle de l'admin, ce qui divise
 * la charge d'onboarding. Il n'a en revanche accès ni à sa commission
 * (`/admin/vendors/:id/commerce`) ni à son activation
 * (`/admin/vendors/:id/activate`) : ces deux gestes engagent la plateforme.
 *
 * `verifyOwnership` autorise le propriétaire **et** l'ADMIN, en se fondant sur
 * le rôle de l'appelant — pas sur celui du propriétaire, ce qui serait un IDOR.
 */
@ApiTags('Vendor onboarding')
@ApiBearerAuth()
@Controller('vendors')
export class VendorOnboardingController {
  constructor(
    private readonly onboarding: VendorOnboardingService,
    private readonly hours: RestaurantHoursService,
    private readonly access: RestaurantAccessService,
  ) {}

  // ─── Lecture (admin ou propriétaire) ───────────────────────────────────────

  @Get(':id/onboarding')
  @Roles('ADMIN', 'RESTAURATEUR')
  @ApiOperation({
    summary: "État de l'onboarding et checklist « prêt à vendre »",
  })
  @ApiParam({ name: 'id', description: 'ID du vendeur (Restaurant)' })
  async getOnboarding(@Param('id') id: string, @CurrentUser() caller: User) {
    await this.access.verifyOwnership(id, caller.firebaseUid);
    return this.onboarding.getOnboardingState(id);
  }

  @Get(':id/preview')
  @Roles('ADMIN', 'RESTAURATEUR')
  @ApiOperation({
    summary: 'Aperçu de la boutique telle que le client la verra',
  })
  async getPreview(@Param('id') id: string, @CurrentUser() caller: User) {
    await this.access.verifyOwnership(id, caller.firebaseUid);
    return this.onboarding.preview(id);
  }

  // ─── Configuration (admin ou propriétaire) ─────────────────────────────────

  @Patch(':id/identity')
  @Roles('ADMIN', 'RESTAURATEUR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Identité et logo du vendeur' })
  async updateIdentity(
    @Param('id') id: string,
    @Body() dto: UpdateVendorIdentityDto,
    @CurrentUser() caller: User,
  ) {
    await this.access.verifyOwnership(id, caller.firebaseUid);
    return this.onboarding.updateIdentity(id, dto);
  }

  @Patch(':id/location')
  @Roles('ADMIN', 'RESTAURATEUR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Adresse, quartier et coordonnées GPS' })
  async updateLocation(
    @Param('id') id: string,
    @Body() dto: UpdateVendorLocationDto,
    @CurrentUser() caller: User,
  ) {
    await this.access.verifyOwnership(id, caller.firebaseUid);
    return this.onboarding.updateLocation(id, dto);
  }

  @Patch(':id/hours')
  @Roles('ADMIN', 'RESTAURATEUR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Horaires d'ouverture de la semaine" })
  async updateHours(
    @Param('id') id: string,
    @Body() dto: UpdateVendorHoursDto,
    @CurrentUser() caller: User,
  ) {
    // Délègue au service existant : les horaires ont déjà leur upsert
    // transactionnel et leur remise à zéro de `manualOverride`. En écrire une
    // seconde version en ferait deux à maintenir.
    return this.hours.setOperatingHours(id, caller.firebaseUid, {
      hours: dto.hours,
    });
  }

  @Patch(':id/delivery')
  @Roles('ADMIN', 'RESTAURATEUR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Livraison, retrait, frais et délais' })
  async updateDelivery(
    @Param('id') id: string,
    @Body() dto: UpdateVendorDeliveryDto,
    @CurrentUser() caller: User,
  ) {
    await this.access.verifyOwnership(id, caller.firebaseUid);
    return this.onboarding.updateDelivery(id, dto);
  }
}

/**
 * Gestes réservés à l'administration : création, commission, activation,
 * invitation. Séparé du contrôleur ci-dessus pour que `@Roles('ADMIN')` porte
 * sur la classe entière — une route sensible ajoutée ici est protégée par
 * défaut, au lieu de dépendre d'un décorateur qu'on aurait pu oublier.
 */
@ApiTags('Vendor onboarding (admin)')
@ApiBearerAuth()
@Controller('admin/vendors')
@Roles('ADMIN')
export class AdminVendorOnboardingController {
  constructor(
    private readonly onboarding: VendorOnboardingService,
    private readonly invitation: VendorInvitationService,
    private readonly vendors: VendorsService,
  ) {}

  @Post()
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: 'Créer un vendeur et le compte de son propriétaire (état DRAFT)',
    description:
      "Le vendeur naît invisible et fermé. Aucun mot de passe n'est choisi " +
      "par l'administrateur : une invitation part vers le propriétaire pour " +
      'qu’il définisse le sien.',
  })
  async create(
    @Body() dto: CreateVendorOnboardingDto,
    @CurrentUser() admin: User,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const created = await this.onboarding.createVendor(
      dto,
      admin.id,
      idempotencyKey,
    );
    // Envoi immédiat ; l'obligation est déjà en outbox, donc un échec ici est
    // rattrapé par le dispatcher plutôt que perdu.
    const invitation = await this.invitation.sendForVendor(
      created.data.vendor.id,
    );
    return { ...created, data: { ...created.data, invitation } };
  }

  @Patch(':id/commerce')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Commission et paramètres commerciaux (ADMIN uniquement)',
  })
  updateCommerce(
    @Param('id') id: string,
    @Body() dto: UpdateVendorCommerceDto,
    @CurrentUser() admin: User,
  ) {
    return this.onboarding.updateCommerce(id, dto, admin.id);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activer le vendeur — refusé si la checklist est incomplète',
  })
  activate(
    @Param('id') id: string,
    @Body() dto: ActivateVendorDto,
    @CurrentUser() admin: User,
  ) {
    return this.onboarding.activate(id, admin.id, dto);
  }

  @Post(':id/resend-invitation')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    short: { limit: 1, ttl: 60000 },
    long: { limit: 5, ttl: 3600000 },
  })
  @ApiOperation({
    summary: "Renvoyer l'invitation d'activation au propriétaire",
  })
  async resendInvitation(@Param('id') id: string) {
    const result = await this.invitation.sendForVendor(id);
    return { data: result, message: 'Invitation renvoyée.' };
  }

  // ─── Mise en ordre et mise en avant du catalogue ───────────────────────────
  //
  // Deux gestes distincts, deux routes. `displayOrder` dit OÙ le vendeur
  // apparaît, `isFeatured` dit s'il porte un badge : les fondre en une seule
  // route obligerait à envoyer l'un pour changer l'autre.
  //
  // ⚠️ Ni l'un ni l'autre ne publie quoi que ce soit — la visibilité reste
  // `POST /admin/vendors/:id/activate` + `approve`.

  @Patch(':id/display-order')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ranger le vendeur dans les listes publiques (1 = premier)',
  })
  @ApiParam({ name: 'id', description: 'ID du vendeur (Restaurant)' })
  setDisplayOrder(
    @Param('id') id: string,
    @Body() dto: UpdateDisplayOrderDto,
    @CurrentUser() admin: User,
  ) {
    return this.vendors.setDisplayOrder(id, dto.displayOrder, admin.id);
  }

  @Patch(':id/feature')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre le vendeur en avant, ou l’en retirer' })
  @ApiParam({ name: 'id', description: 'ID du vendeur (Restaurant)' })
  setFeatured(
    @Param('id') id: string,
    @Body() dto: UpdateFeaturedDto,
    @CurrentUser() admin: User,
  ) {
    return this.vendors.setFeatured(id, dto.isFeatured, admin.id);
  }
}
