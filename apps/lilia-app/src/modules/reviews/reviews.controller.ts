import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { DecodedIdToken } from 'firebase-admin/auth';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto, UpdateReviewDto } from './dto';
import { Public } from '../auth/decorators/public.decorator';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';

@ApiTags('Reviews')
@ApiBearerAuth()
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post()
  @ApiBearerAuth()
  // Anti-abus (CRIT-7) : limite la création d'avis en rafale (faux avis, spam).
  @Throttle({ short: { limit: 2, ttl: 1000 }, long: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Créer un avis' })
  create(
    @Body() createReviewDto: CreateReviewDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.reviewsService.create(createReviewDto, fbUser.uid);
  }

  @Public()
  @Get('restaurant/:restaurantId')
  @ApiOperation({ summary: "Récupérer tous les avis d'un restaurant" })
  findByRestaurant(
    @Param('restaurantId') restaurantId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.reviewsService.findByRestaurant(
      restaurantId,
      query.page,
      query.limit,
    );
  }

  @Public()
  @Get('restaurant/:restaurantId/stats')
  @ApiOperation({ summary: "Récupérer les statistiques d'un restaurant" })
  getStats(@Param('restaurantId') restaurantId: string) {
    // `assertVisible: true` — route publique, donc soumise à la frontière de
    // visibilité. `getRestaurantStats` est aussi appelée en interne par
    // `findByRestaurant`, qui a déjà fait le contrôle : le paramètre évite d'y
    // refaire la même requête.
    return this.reviewsService.getRestaurantStats(restaurantId, true);
  }

  @Get('restaurant/:restaurantId/my-review')
  @ApiOperation({ summary: 'Récupérer mon avis pour un restaurant' })
  getUserReview(
    @Param('restaurantId') restaurantId: string,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.reviewsService.getUserReview(restaurantId, fbUser.uid);
  }

  @Get('restaurant/:restaurantId/can-review')
  @ApiOperation({ summary: 'Vérifier si je peux laisser un avis' })
  canReview(
    @Param('restaurantId') restaurantId: string,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.reviewsService.canReview(restaurantId, fbUser.uid);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Récupérer un avis par son ID' })
  findOne(@Param('id') id: string) {
    return this.reviewsService.findOne(id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Modifier un avis' })
  update(
    @Param('id') id: string,
    @Body() updateReviewDto: UpdateReviewDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.reviewsService.update(id, updateReviewDto, fbUser.uid);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer un avis' })
  remove(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.reviewsService.remove(id, fbUser.uid);
  }
}
