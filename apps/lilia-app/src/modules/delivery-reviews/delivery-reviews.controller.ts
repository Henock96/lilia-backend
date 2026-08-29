/* eslint-disable prettier/prettier */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { DecodedIdToken } from 'firebase-admin/auth';

import { DeliveryReviewsService } from './delivery-reviews.service';
import { CreateDeliveryReviewDto } from './dto/create-delivery-review.dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';

@ApiTags('DeliveryReviews')
@ApiBearerAuth()
@Controller('delivery-reviews')
export class DeliveryReviewsController {
  constructor(private readonly service: DeliveryReviewsService) {}

  /**
   * Le client note le livreur après réception de sa commande.
   * Une seule note par livraison — la contrainte est en base.
   */
  @Post()
  @Roles('CLIENT', 'ADMIN')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Noter le livreur (1 à 5 étoiles)' })
  create(
    @Body() dto: CreateDeliveryReviewDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.service.create(dto, fbUser.uid);
  }

  /** Les notes reçues par le livreur connecté. */
  @Get('mine')
  @Roles('LIVREUR')
  @ApiOperation({ summary: 'Mes notes (livreur)' })
  findMine(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query() query: PaginationQueryDto,
  ) {
    return this.service.findMine(fbUser.uid, query.page, query.limit);
  }

  /**
   * Note moyenne d'un livreur.
   *
   * Publique : c'est une information d'affichage (comme la note d'un vendeur),
   * et elle ne contient ni identité de client ni détail de course.
   */
  @Public()
  @Get('deliverer/:delivererId/stats')
  @ApiOperation({ summary: 'Note moyenne et distribution d’un livreur' })
  @ApiParam({ name: 'delivererId' })
  getDelivererStats(@Param('delivererId') delivererId: string) {
    return this.service.getDelivererStats(delivererId);
  }

  /** La note déjà laissée pour une livraison, s'il y en a une. */
  @Get('by-delivery/:deliveryId')
  @Roles('CLIENT', 'LIVREUR', 'ADMIN')
  @ApiOperation({ summary: 'Note existante pour une livraison' })
  @ApiParam({ name: 'deliveryId' })
  findByDelivery(
    @Param('deliveryId') deliveryId: string,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.service.findByDelivery(deliveryId, fbUser.uid);
  }
}
