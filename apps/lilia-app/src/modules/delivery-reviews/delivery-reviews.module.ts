import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { DeliveryReviewsService } from './delivery-reviews.service';
import { DeliveryReviewsController } from './delivery-reviews.controller';

/**
 * Notation du livreur (1 à 5 étoiles) après livraison.
 * Distinct de `ReviewsModule`, qui note les vendeurs.
 */
@Module({
  imports: [PrismaModule],
  providers: [DeliveryReviewsService],
  controllers: [DeliveryReviewsController],
  exports: [DeliveryReviewsService],
})
export class DeliveryReviewsModule {}
