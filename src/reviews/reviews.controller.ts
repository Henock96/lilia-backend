import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto, UpdateReviewDto } from './dto';
import { FirebaseAuthGuard } from '../firebase/firebase-auth.guard';

@ApiTags('Reviews')
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post()
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Créer un avis' })
  create(@Body() createReviewDto: CreateReviewDto, @Req() req) {
    return this.reviewsService.create(createReviewDto, req.user.uid);
  }

  @Get('restaurant/:restaurantId')
  @ApiOperation({ summary: 'Récupérer tous les avis d\'un restaurant' })
  findByRestaurant(@Param('restaurantId') restaurantId: string) {
    return this.reviewsService.findByRestaurant(restaurantId);
  }

  @Get('restaurant/:restaurantId/stats')
  @ApiOperation({ summary: 'Récupérer les statistiques d\'un restaurant' })
  getStats(@Param('restaurantId') restaurantId: string) {
    return this.reviewsService.getRestaurantStats(restaurantId);
  }

  @Get('restaurant/:restaurantId/my-review')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Récupérer mon avis pour un restaurant' })
  getUserReview(@Param('restaurantId') restaurantId: string, @Req() req) {
    return this.reviewsService.getUserReview(restaurantId, req.user.uid);
  }

  @Get('restaurant/:restaurantId/can-review')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Vérifier si je peux laisser un avis' })
  canReview(@Param('restaurantId') restaurantId: string, @Req() req) {
    return this.reviewsService.canReview(restaurantId, req.user.uid);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Récupérer un avis par son ID' })
  findOne(@Param('id') id: string) {
    return this.reviewsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Modifier un avis' })
  update(
    @Param('id') id: string,
    @Body() updateReviewDto: UpdateReviewDto,
    @Req() req,
  ) {
    return this.reviewsService.update(id, updateReviewDto, req.user.uid);
  }

  @Delete(':id')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Supprimer un avis' })
  remove(@Param('id') id: string, @Req() req) {
    return this.reviewsService.remove(id, req.user.uid);
  }
}
