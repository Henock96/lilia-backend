import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { BannersService } from './banners.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { RolesGuard } from 'src/firebase/roles.guard';
import { Roles } from 'src/firebase/roles.decorator';

@Controller('banners')
export class BannersController {
  constructor(private readonly bannersService: BannersService) {}

  @Get()
  findAll(@Query('restaurantId') restaurantId?: string) {
    return this.bannersService.findAll(restaurantId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.bannersService.findOne(id);
  }

  @Post()
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  create(@Body() createBannerDto: CreateBannerDto, @Req() req) {
    return this.bannersService.create(createBannerDto, req.user.uid);
  }

  @Patch(':id')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  update(
    @Param('id') id: string,
    @Body() updateBannerDto: UpdateBannerDto,
    @Req() req,
  ) {
    return this.bannersService.update(id, updateBannerDto, req.user.uid);
  }

  @Delete(':id')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  remove(@Param('id') id: string, @Req() req) {
    return this.bannersService.remove(id, req.user.uid);
  }

  @Patch(':id/reorder')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  reorder(
    @Param('id') id: string,
    @Body('displayOrder') displayOrder: number,
    @Req() req,
  ) {
    return this.bannersService.reorder(id, displayOrder, req.user.uid);
  }
}
