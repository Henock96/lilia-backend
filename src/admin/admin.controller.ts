import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../firebase/firebase-auth.guard';
import { RolesGuard } from '../firebase/roles.guard';
import { Roles } from '../firebase/roles.decorator';
import { AdminService } from './admin.service';
import { CreateRestaurantWithOwnerDto } from './dto/create-restaurant-with-owner.dto';

@Controller('admin')
@UseGuards(FirebaseAuthGuard, RolesGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('create-restaurant')
  @Roles('ADMIN')
  async createRestaurantWithOwner(
    @Body() dto: CreateRestaurantWithOwnerDto,
  ) {
    return this.adminService.createRestaurantWithOwner(dto);
  }

  @Patch('restaurants/:id/toggle-active')
  @Roles('ADMIN')
  async toggleRestaurantActive(
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
  ) {
    return this.adminService.toggleRestaurantActive(id, isActive);
  }

  @Get('restaurants')
  @Roles('ADMIN')
  async getAllRestaurants() {
    return this.adminService.getAllRestaurants();
  }

  @Get('clients')
  @Roles('ADMIN')
  async getAllClients() {
    return this.adminService.getAllClients();
  }
}
