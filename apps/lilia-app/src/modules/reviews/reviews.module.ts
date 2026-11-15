import { Module } from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { ReviewModerationService } from './review-moderation.service';
import {
  AdminReviewModerationController,
  VendorReviewsController,
} from './review-moderation.controller';

@Module({
  controllers: [
    ReviewsController,
    VendorReviewsController,
    AdminReviewModerationController,
  ],
  providers: [ReviewsService, ReviewModerationService, PrismaService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
