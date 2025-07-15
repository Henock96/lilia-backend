/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { RestaurantsService } from './restaurants.service';
import { CreateRestaurantDto } from './dto/create-restaurant.dto';
import { Roles } from 'src/firebase/roles.decorator';
import { RolesGuard } from 'src/firebase/roles.guard';

@Controller('restaurants')
export class RestaurantsController {
    constructor(private readonly service: RestaurantsService){}

    // Endpoint public pour lister tous les restaurants
    @Get()
    findAll() {
        return this.service.findRestaurant();
    }

    // Endpoint public pour récupérer un restaurant par son ID avec ses produits
    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.service.findOne(id);
    }

    // Endpoint protégé pour créer un restaurant
    @Post()
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    create(@Body() dto: CreateRestaurantDto, @Req() req){
        return this.service.create(dto, req.user.uid)
    }

    // Endpoint protégé pour que le restaurateur récupère son propre restaurant
    @Get('mine')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    findMine(@Req() req) {
        return this.service.findMine(req.user.uid);
    }
}
