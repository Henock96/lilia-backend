import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuditAction, Prisma, User } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { PlatformSettingsService } from './platform-settings.service';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';

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
  constructor(private readonly service: PlatformSettingsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Paramètres publics (estimation côté client)' })
  async get() {
    const settings = await this.service.getSettings();
    return {
      data: {
        serviceFeePercent: settings.serviceFeePercent,
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
        maintenanceMessage: settings.maintenanceMessage,

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
        updateMessage: settings.updateMessage,
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
      'valeurs avant/après des seuls champs réellement modifiés.',
  })
  async update(
    @Body() dto: UpdatePlatformSettingsDto,
    @CurrentUser() admin: User,
  ) {
    const before = await this.service.getSettings();
    const settings = await this.service.updateSettings(dto);

    // On ne journalise que ce qui a bougé : un diff intégral à chaque
    // enregistrement noierait le champ qui compte parmi neuf inchangés.
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of Object.keys(dto) as (keyof UpdatePlatformSettingsDto)[]) {
      const previous = (before as Record<string, unknown>)[key];
      const next = (settings as Record<string, unknown>)[key];
      if (previous !== next) {
        changes[key] = { before: previous, after: next };
      }
    }

    if (Object.keys(changes).length > 0) {
      await this.audit.record({
        actorId: admin.id,
        action: AdminAuditAction.PLATFORM_SETTINGS_CHANGED,
        targetType: 'User', // pas de cible métier : le réglage est global
        targetId: 'platform-settings',
        metadata: changes as unknown as Prisma.InputJsonValue,
      });
    }

    return { data: settings };
  }
}
