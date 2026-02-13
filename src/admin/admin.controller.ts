import { Body, Controller, Post, UseGuards } from '@nestjs/common';
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
}
