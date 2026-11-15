import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  AdminReviewsQueryDto,
  HideReviewDto,
  VendorReplyDto,
  VendorReviewsQueryDto,
} from './dto';
import { ReviewModerationService } from './review-moderation.service';
import { ReviewsService } from './reviews.service';

/**
 * Lot B — avis reçus par le vendeur, et sa réponse publique. Les boutiques
 * viennent du compte (propriété ou adhésion), jamais de la requête seule :
 * un `restaurantId` étranger est refusé côté serveur.
 */
@ApiTags('Reviews')
@ApiBearerAuth()
@Controller('vendors/me/reviews')
@Roles('RESTAURATEUR')
export class VendorReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @ApiOperation({ summary: 'Avis reçus par mes boutiques (auteur anonyme)' })
  list(@CurrentUser() user: User, @Query() query: VendorReviewsQueryDto) {
    return this.reviews.listForVendor(user.id, query);
  }

  @Put(':id/reply')
  @Throttle({ short: { limit: 2, ttl: 1000 }, long: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: 'Répondre publiquement à un avis (modifiable)' })
  reply(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: VendorReplyDto,
  ) {
    return this.reviews.replyAsVendor(user.id, id, dto.text);
  }
}

/**
 * Lot B (D4.b) — modération des avis par l'administration. Masquer est
 * réversible et audité ; aucune capacité financière n'est en jeu (classement
 * `NONE`, comme la lecture et la suppression d'avis existantes).
 */
@ApiTags('Reviews')
@ApiBearerAuth()
@Controller('admin/review-moderation')
@Roles('ADMIN')
export class AdminReviewModerationController {
  constructor(private readonly moderation: ReviewModerationService) {}

  @Get('reviews')
  @ApiOperation({ summary: 'Avis vendeurs (filtres note, boutique, masqués)' })
  listReviews(@Query() query: AdminReviewsQueryDto) {
    return this.moderation.listReviews(query);
  }

  @Get('delivery-reviews')
  @ApiOperation({ summary: 'Notes livreurs (filtres note, livreur, masquées)' })
  listDeliveryReviews(@Query() query: AdminReviewsQueryDto) {
    return this.moderation.listDeliveryReviews(query);
  }

  @Post('reviews/:id/hide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Masquer un avis (motif obligatoire)' })
  hideReview(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: HideReviewDto,
  ) {
    return this.moderation.hide('REVIEW', id, user.id, dto.reason);
  }

  @Post('reviews/:id/unhide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rétablir un avis masqué' })
  unhideReview(@CurrentUser() user: User, @Param('id') id: string) {
    return this.moderation.unhide('REVIEW', id, user.id);
  }

  @Post('reviews/:id/reply/hide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Masquer la réponse du vendeur (motif obligatoire)',
  })
  hideReply(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: HideReviewDto,
  ) {
    return this.moderation.hide('VENDOR_REPLY', id, user.id, dto.reason);
  }

  @Post('reviews/:id/reply/unhide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rétablir la réponse du vendeur' })
  unhideReply(@CurrentUser() user: User, @Param('id') id: string) {
    return this.moderation.unhide('VENDOR_REPLY', id, user.id);
  }

  @Post('delivery-reviews/:id/hide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Masquer une note de livreur (motif obligatoire)' })
  hideDeliveryReview(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: HideReviewDto,
  ) {
    return this.moderation.hide('DELIVERY_REVIEW', id, user.id, dto.reason);
  }

  @Post('delivery-reviews/:id/unhide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rétablir une note de livreur' })
  unhideDeliveryReview(@CurrentUser() user: User, @Param('id') id: string) {
    return this.moderation.unhide('DELIVERY_REVIEW', id, user.id);
  }
}
