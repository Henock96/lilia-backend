/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { RestaurantsService } from './restaurants.service';
import {
    CreateRestaurantDto,
    UpdateDeliverySettingsDto,
    UpdateOpenStatusDto,
    AddSpecialtyDto,
    UpdateRestaurantDto
} from './dto/create-restaurant.dto';
import { Roles } from 'src/firebase/roles.decorator';
import { RolesGuard } from 'src/firebase/roles.guard';
import { DayOfWeek, SetOperatingHoursDto, UpdateOperatingHourDto } from './dto/operating-hours.dto';

@Controller('restaurants')
export class RestaurantsController {
    constructor(private readonly service: RestaurantsService){}

    // Endpoint public pour lister tous les restaurants
    @Get()
    findAll() {
        return this.service.findRestaurant();
    }

    @Get('/nombre-commandes')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    findCountOrders(@Req() req) {
        return this.service.findOne(req.user.uid);
    }

    // Endpoint protégé pour que le restaurateur récupère son propre restaurant
    // IMPORTANT: Cette route doit être AVANT :id pour éviter que 'mine' soit interprété comme un ID
    @Get('mine')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    findMine(@Req() req) {
        return this.service.findRestaurantOwner(req.user.uid);
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

    // ============ NOUVEAUX ENDPOINTS ============

    /**
     * PATCH /restaurants/:id
     * Met à jour les informations générales du restaurant
     */
    @Patch(':id')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    updateRestaurant(
        @Param('id') id: string,
        @Body() dto: UpdateRestaurantDto,
        @Req() req,
    ) {
        return this.service.updateRestaurant(id, req.user.uid, dto);
    }

    /**
     * PATCH /restaurants/:id/open-status
     * Active/désactive le restaurant (ouvert/fermé)
     */
    @Patch(':id/open-status')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    updateOpenStatus(
        @Param('id') id: string,
        @Body() dto: UpdateOpenStatusDto,
        @Req() req,
    ) {
        return this.service.updateOpenStatus(id, req.user.uid, dto);
    }

    /**
     * PATCH /restaurants/:id/delivery-settings
     * Met à jour les paramètres de livraison
     */
    @Patch(':id/delivery-settings')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    updateDeliverySettings(
        @Param('id') id: string,
        @Body() dto: UpdateDeliverySettingsDto,
        @Req() req,
    ) {
        return this.service.updateDeliverySettings(id, req.user.uid, dto);
    }

    // ============ ENDPOINTS SPÉCIALITÉS ============

    /**
     * GET /restaurants/:id/specialties
     * Récupère les spécialités d'un restaurant
     */
    @Get(':id/specialties')
    getSpecialties(@Param('id') id: string) {
        return this.service.getSpecialties(id);
    }

    /**
     * POST /restaurants/:id/specialties
     * Ajoute une spécialité au restaurant
     */
    @Post(':id/specialties')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    addSpecialty(
        @Param('id') id: string,
        @Body() dto: AddSpecialtyDto,
        @Req() req,
    ) {
        return this.service.addSpecialty(id, req.user.uid, dto);
    }

    /**
     * DELETE /restaurants/:id/specialties/:specialtyId
     * Supprime une spécialité du restaurant
     */
    @Delete(':id/specialties/:specialtyId')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    removeSpecialty(
        @Param('id') id: string,
        @Param('specialtyId') specialtyId: string,
        @Req() req,
    ) {
        return this.service.removeSpecialty(id, specialtyId, req.user.uid);
    }

    // ============ ENDPOINTS HORAIRES D'OUVERTURE ============

    /**
     * GET /restaurants/:id/operating-hours
     * Récupère les horaires d'ouverture d'un restaurant (public)
     */
    @Get(':id/operating-hours')
    getOperatingHours(@Param('id') id: string) {
        return this.service.getOperatingHours(id);
    }

    /**
     * PUT /restaurants/:id/operating-hours
     * Définit les horaires de la semaine (bulk upsert)
     */
    @Put(':id/operating-hours')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    setOperatingHours(
        @Param('id') id: string,
        @Body() dto: SetOperatingHoursDto,
        @Req() req,
    ) {
        return this.service.setOperatingHours(id, req.user.uid, dto);
    }

    /**
     * PATCH /restaurants/:id/operating-hours/:dayOfWeek
     * Modifier un seul jour
     */
    @Patch(':id/operating-hours/:dayOfWeek')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    updateOperatingHour(
        @Param('id') id: string,
        @Param('dayOfWeek') dayOfWeek: DayOfWeek,
        @Body() dto: UpdateOperatingHourDto,
        @Req() req,
    ) {
        return this.service.updateOperatingHour(id, dayOfWeek, req.user.uid, dto);
    }

    // ============ ENDPOINTS CLIENTS ============

    // Endpoint pour récupérer les clients d'un restaurant spécifique
    @Get(':id/clients')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    findClients(@Param('id') id: string, @Query('page') page: number, @Query('limit') limit: number) {
        return this.service.findClients(page, limit, id);
    }

    @Get(':id/clients/:userId/orders')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    async getClientOrders(
        @Param('id') restaurantId: string,
        @Param('userId') userId: string,
    ) {
        return this.service.findClientWithOrders(restaurantId, userId);
    }
}
