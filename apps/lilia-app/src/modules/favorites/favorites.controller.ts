import { Controller, Get, Post, Delete, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { FavoritesService } from './favorites.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';

@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Get()
  getMyFavorites(@CurrentUser() user: User) {
    return this.favoritesService.getMyFavorites(user.id);
  }

  @Post(':restaurantId')
  addFavorite(@CurrentUser() user: User, @Param('restaurantId') restaurantId: string) {
    return this.favoritesService.addFavorite(user.id, restaurantId);
  }

  @Delete(':restaurantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeFavorite(@CurrentUser() user: User, @Param('restaurantId') restaurantId: string) {
    return this.favoritesService.removeFavorite(user.id, restaurantId);
  }

  @Get(':restaurantId/check')
  checkFavorite(@CurrentUser() user: User, @Param('restaurantId') restaurantId: string) {
    return this.favoritesService.isFavorite(user.id, restaurantId);
  }
}
