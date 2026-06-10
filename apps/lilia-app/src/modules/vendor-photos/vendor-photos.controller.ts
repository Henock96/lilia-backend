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
import { VendorPhotosService } from './vendor-photos.service';
import {
  CreateVendorPhotoDto,
  UpdateVendorPhotoDto,
  ReorderVendorPhotosDto,
} from './dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('VendorPhotos')
@ApiBearerAuth()
@Controller('vendor-photos')
export class VendorPhotosController {
  constructor(private readonly service: VendorPhotosService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: "Liste les photos d'un restaurant (public)" })
  list(@Query('restaurantId') restaurantId: string) {
    return this.service.list(restaurantId);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Post()
  @ApiOperation({ summary: 'Ajoute une photo au restaurant (max 5)' })
  create(@Body() dto: CreateVendorPhotoDto, @CurrentUser() user: User) {
    return this.service.create(dto, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Modifie alt / displayOrder / isCover' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateVendorPhotoDto,
    @CurrentUser() user: User,
  ) {
    return this.service.update(id, dto, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprime la photo + cleanup Cloudinary' })
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.service.remove(id, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Réordonne les photos (transaction)' })
  reorder(@Body() dto: ReorderVendorPhotosDto, @CurrentUser() user: User) {
    return this.service.reorder(dto, user);
  }
}
