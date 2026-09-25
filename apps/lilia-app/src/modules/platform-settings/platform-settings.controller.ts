import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { AdminCapability } from '@prisma/client';
import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuditAction, Prisma, User } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { PlatformSettingsService } from './platform-settings.service';
import { DeliveryPricingService } from '../delivery-pricing/delivery-pricing.service';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';

function blankToNull(value: string | null): string | null {
  return value && value.trim() !== '' ? value : null;
}

/**
 * Paramètres publics nécessaires aux clients pour **estimer** un montant avant
 * checkout (frais de service, barème de fidélité).
 *
 * Les apps codaient ces valeurs en dur (8 % de commission, 1 pt = 5 XAF) : le
 * jour où l'admin change le taux, toutes les versions installées affichent
 * encore l'ancien — sans aucun signal. Le total facturé reste calculé par le
 * serveur au checkout ; cet endpoint ne sert qu'à l'affichage.
 */
@ApiTags('Platform Settings')
@Controller('platform-settings')
export class PublicPlatformSettingsController {
  constructor(
    private readonly service: PlatformSettingsService,
    private readonly deliveryPricing: DeliveryPricingService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Paramètres publics (estimation côté client)' })
  async get() {
    const settings = await this.service.getSettings();
    const deliveryFeeFromXaf = await this.deliveryPricing.publicFloorFeeXaf();
    return {
      data: {
        serviceFeePercent: settings.serviceFeePercent,
        // F3-02 — qui fixe le prix de la course. En `PLATFORM`, le
        // `fixedDeliveryFee` d'un vendeur ne veut plus rien dire : les apps
        // affichent « dès `deliveryFeeFromXaf` » et chiffrent la course par
        // `GET /quartiers/delivery-fee`, jamais localement.
        deliveryPricingMode: settings.deliveryPricingMode,
        deliveryFeeFromXaf,
        loyaltyPointsPerOrder: settings.loyaltyPointsPerOrder,
        loyaltyPointValueXaf: settings.loyaltyPointValueXaf,
        loyaltyMinRedemption: settings.loyaltyMinRedemption,
        // Le barème de parrainage est désormais public. Il ne l'était pas, et
        // les quatre interfaces l'écrivaient donc en dur — « +500 pts pour
        // vous, +200 pts pour lui » restait affiché après que l'administrateur
        // eut changé les valeurs. Une donnée qu'on affiche doit être une donnée
        // qu'on peut lire.
        referrerBonusPoints: settings.referrerBonusPoints,
        maintenanceMode: settings.maintenanceMode,
        // `""` et `null` voulaient tous deux dire « pas de message », mais les
        // clients ne les traitent pas pareil (`??` laisse passer `""`). Les
        // lignes écrites avant la normalisation du DTO en portent encore.
        maintenanceMessage: blankToNull(settings.maintenanceMessage),

        // Pilotage du parc installé. Ces cinq champs doivent rester sur la
        // route **publique** : une application trop ancienne pour parler le
        // contrat d'API courant doit tout de même pouvoir apprendre qu'elle
        // est périmée, et elle ne peut le faire que sans authentification.
        // Les servir derrière un guard reviendrait à ne prévenir que les
        // clients qui n'en ont pas besoin.
        minAppVersion: settings.minAppVersion,
        latestAppVersion: settings.latestAppVersion,
        updateUrlAndroid: settings.updateUrlAndroid,
        updateUrlIos: settings.updateUrlIos,
        updateMessage: blankToNull(settings.updateMessage),
      },
    };
  }
}

/**
 * Configuration plateforme — ADMIN uniquement.
 * Guards globaux actifs (APP_GUARD) — pas de @UseGuards() nécessaire.
 */
@ApiTags('Platform Settings')
@ApiBearerAuth()
@Controller('admin/platform-settings')
@Roles('ADMIN')
export class PlatformSettingsController {
  constructor(
    private readonly service: PlatformSettingsService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Configuration plateforme' })
  async get() {
    return { data: await this.service.getSettings() };
  }

  /**
   * ⚠️ Geste financier, pas réglage d'interface.
   *
   * Changer `loyaltyPointValueXaf` revalorise d'un coup tout le passif déjà
   * distribué. Le changement laissait pourtant **aucune trace** : ni auteur, ni
   * date, ni valeur précédente. Il est désormais journalisé avec son avant/après.
   */
  @Patch()
  @ApiOperation({
    summary: 'Mettre à jour la configuration plateforme',
    description:
      'Journalisé dans `AdminAuditLog` (`PLATFORM_SETTINGS_CHANGED`) avec les ' +
      'valeurs avant/après des seuls champs réellement modifiés. ' +
      '`expectedUpdatedAt` (facultatif) active le verrou optimiste : 409 si la ' +
      'configuration a changé depuis son chargement. 400 si le canal de mise à ' +
      'jour résultant est incohérent (voir `app-update-policy.ts`).',
  })
  @RequireCapability(AdminCapability.SETTINGS)
  async update(
    @Body() dto: UpdatePlatformSettingsDto,
    @CurrentUser() admin: User,
  ) {
    // `before` vient de la lecture fraîche faite par le service sous verrou
    // optimiste — plus du cache, qui pouvait avoir 60 s et fausser l'« avant »
    // du journal.
    const { before, after, changes } = await this.service.updateSettings(dto);

    // On ne journalise que ce qui a bougé : un diff intégral à chaque
    // enregistrement noierait le champ qui compte parmi neuf inchangés.
    const diff: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of Object.keys(changes)) {
      const previous = (before as Record<string, unknown>)[key];
      const next = (after as Record<string, unknown>)[key];
      if (previous !== next) {
        diff[key] = { before: previous, after: next };
      }
    }

    if (Object.keys(diff).length > 0) {
      await this.audit.record({
        actorId: admin.id,
        action: AdminAuditAction.PLATFORM_SETTINGS_CHANGED,
        targetType: 'User', // pas de cible métier : le réglage est global
        targetId: 'platform-settings',
        metadata: diff as unknown as Prisma.InputJsonValue,
      });
    }

    return { data: after };
  }
}
