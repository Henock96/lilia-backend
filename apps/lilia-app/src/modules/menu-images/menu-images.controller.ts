import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MenuImagesService } from './menu-images.service';
import {
  CreateMenuImageDto,
  UpdateMenuImageDto,
  ReorderMenuImagesDto,
} from './dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('MenuImages')
@ApiBearerAuth()
@Controller('menu-images')
export class MenuImagesController {
  constructor(private readonly service: MenuImagesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: "Liste les images d'un menu (public)" })
  list(@Query('menuDuJourId') menuDuJourId: string) {
    return this.service.list(menuDuJourId);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Post()
  @ApiOperation({ summary: 'Ajoute une image au menu (max 5)' })
  create(@Body() dto: CreateMenuImageDto, @CurrentUser() user: User) {
    return this.service.create(dto, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Modifie alt / displayOrder / isCover' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateMenuImageDto,
    @CurrentUser() user: User,
  ) {
    return this.service.update(id, dto, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprime l\'image + cleanup Cloudinary' })
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.service.remove(id, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Réordonne les images (transaction)' })
  reorder(@Body() dto: ReorderMenuImagesDto, @CurrentUser() user: User) {
    return this.service.reorder(dto, user);
  }
}
