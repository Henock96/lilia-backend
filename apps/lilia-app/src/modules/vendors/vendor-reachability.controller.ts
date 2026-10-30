import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../auth/decorators/roles.decorator';
import { VendorReachabilityService } from './vendor-reachability.service';

/**
 * Joignabilité des boutiques (audit du 28/10/2026, F-03). ADMIN seulement :
 * la liste couvre toutes les boutiques, aucune donnée n'y est propre à
 * l'appelant. Lecture seule ; ni token FCM ni numéro dans la réponse.
 */
@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/vendors')
@Roles('ADMIN')
export class AdminVendorReachabilityController {
  constructor(private readonly reachability: VendorReachabilityService) {}

  @Get('reachability')
  @ApiOperation({
    summary:
      'Joignabilité des boutiques pour les commandes (appareils inscrits, SMS de secours)',
  })
  async list() {
    const rows = await this.reachability.list();
    return {
      data: rows,
      summary: {
        total: rows.length,
        needsAction: rows.filter((r) => r.needsAction).length,
      },
    };
  }
}
