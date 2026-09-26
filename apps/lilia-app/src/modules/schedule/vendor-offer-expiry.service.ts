import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CronLockService } from '../../common/locks/cron-lock.service';
import { VendorOffersService } from '../vendor-offers/vendor-offers.service';

/**
 * F3-11 — passe en `ENDED` les offres boutique arrivées à échéance et prévient
 * leur vendeur.
 *
 * Le checkout n'attend pas ce cron : il ne retient jamais une offre dont
 * `endsAt` est passé. Ce tour ne sert qu'à dire au vendeur que son offre est
 * finie, et à libérer la place d'une nouvelle (une seule offre active).
 */
@Injectable()
export class VendorOfferExpiryService {
  private readonly logger = new Logger(VendorOfferExpiryService.name);

  constructor(
    private readonly offers: VendorOffersService,
    private readonly cronLock: CronLockService,
  ) {}

  @Cron('*/10 * * * *', { name: 'end-expired-vendor-offers' })
  async run(): Promise<void> {
    await this.cronLock.runExclusively(
      'end-expired-vendor-offers',
      300,
      async () => {
        const ended = await this.offers.endExpired();
        if (ended > 0)
          this.logger.log(`🏷️ ${ended} offre(s) boutique terminée(s)`);
      },
    );
  }
}
