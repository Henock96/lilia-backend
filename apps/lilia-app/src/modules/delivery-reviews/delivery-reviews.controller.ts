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
   * **Authentifiée**, contrairement à la note d'un vendeur à laquelle elle
   * avait été assimilée (audit post-correction, B-5). La différence est que
   * l'objet noté est ici une personne, pas un commerce : la moyenne et la
   * distribution des notes d'un livreur constituent une évaluation de
   * performance individuelle.
   *
   * Ouverte sans authentification, elle permettait de balayer les identifiants
   * de livreurs — que `GET /deliveries/deliverers` et les payloads de course
   * exposent aux vendeurs — pour reconstituer le classement de tous les
   * livreurs de la plateforme depuis l'extérieur.
   *
   * Aucun appelant anonyme n'en avait besoin : les deux consommateurs (app
   * livreur pour ses propres notes, app admin pour la supervision) sont
   * authentifiés. Le rôle reste large — un client peut légitimement voir la
   * note de celui qui lui livre.
   */
  @Roles('CLIENT', 'LIVREUR', 'RESTAURATEUR', 'ADMIN')
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
