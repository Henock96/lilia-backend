/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { RestaurantsService } from './restaurants.service';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { DecodedIdToken } from 'firebase-admin/auth';

import {
    CreateRestaurantDto,
    UpdateDeliverySettingsDto,
    UpdateOpenStatusDto,
    AddSpecialtyDto,
    UpdateRestaurantDto
} from './dto/create-restaurant.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { DayOfWeek, SetOperatingHoursDto, UpdateOperatingHourDto } from './dto/operating-hours.dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';

/**
 * Guards globaux actifs (APP_GUARD dans AuthModule) :
 *   FirebaseAuthGuard → vérifie Bearer token
 *   RolesGuard        → vérifie @Roles() si présent
 *
 * Routes publiques marquées @Public() — court-circuitent FirebaseAuthGuard.
 *
 * Ordre des routes statiques IMPORTANT (NestJS résout de haut en bas) :
 *   /restaurants/popular  \
 *   /restaurants/mine      → doivent être AVANT /restaurants/:id
 *   /restaurants/...       /
 *   /restaurants/:id      → wildcard en dernier
 */
@ApiTags('Restaurants')
@ApiBearerAuth()
@Controller('restaurants')
export class RestaurantsController {
    constructor(private readonly service: RestaurantsService){}

// ─── ROUTES PUBLIQUES ──────────────────────────────────────────────────────


    // Endpoint public pour lister tous les restaurants
    @Public()
    @Get()
    @ApiOperation({ summary: 'Liste tous les restaurants actifs' })
    findAll() {
        return this.service.findAll();
    }

    @Public()
    @Get('popular')
    @ApiOperation({ summary: 'Restaurants les plus commandés' })
    findPopular(@Query('limit') limit = '6') {
        return this.service.findPopular(parseInt(limit, 10));
    }
  // ─── ROUTES AUTHENTIFIÉES STATIQUES (avant :id) ───────────────────────────

    // Endpoint protégé pour que le restaurateur récupère son propre restaurant
    // IMPORTANT: Cette route doit être AVANT :id pour éviter que 'mine' soit interprété comme un ID
    @Get('mine')
    @Roles('ADMIN', 'RESTAURATEUR')
    @ApiOperation({ summary: 'Mon restaurant (restaurateur connecté)' })
    findMine(@FirebaseUser() fbUser: DecodedIdToken) {
        return this.service.findMyRestaurant(fbUser.uid);
    }
    // ─── ROUTES PUBLIQUES AVEC PARAM (après les statiques) ────────────────────

    @Public()
    @Get(':id')
    @ApiOperation({ summary: 'Détail d\'un restaurant avec ses produits' })
    @ApiParam({ name: 'id', description: 'ID du restaurant' })
    findOne(@Param('id') id: string) {
        return this.service.findOne(id);
    }

    @Public()
    @Get(':id/specialties')
    @ApiOperation({ summary: 'Spécialités d\'un restaurant' })
    getSpecialties(@Param('id') id: string) {
        return this.service.getSpecialties(id);
    }

    @Public()
    @Get(':id/operating-hours')
    @ApiOperation({ summary: 'Horaires d\'ouverture d\'un restaurant' })
    getOperatingHours(@Param('id') id: string) {
        return this.service.getOperatingHours(id);
    }

  // ─── CRÉATION ──────────────────────────────────────────────────────────────

    // Endpoint protégé pour créer un restaurant
    @Post()
    @Roles('ADMIN', 'RESTAURATEUR')
    @ApiOperation({ summary: 'Créer un restaurant' })
    create(@Body() dto: CreateRestaurantDto, @FirebaseUser() fbUser: DecodedIdToken,){
        return this.service.create(dto, fbUser.uid)
    }

  // ─── MUTATIONS RESTAURANT ──────────────────────────────────────────────────

    /**
     * PATCH /restaurants/:id
     * Met à jour les informations générales du restaurant
     */
    @Patch(':id')
    @Roles('ADMIN', 'RESTAURATEUR')
    @ApiOperation({ summary: 'Mettre à jour les infos du restaurant' })
    updateRestaurant(
        @Param('id') id: string,
        @Body() dto: UpdateRestaurantDto,
        @FirebaseUser() fbUser: DecodedIdToken,
    ) {
        return this.service.updateRestaurant(id, fbUser.uid, dto);
    }

    /**
     * PATCH /restaurants/:id/open-status
     * Active/désactive le restaurant (ouvert/fermé)
     */
    @Patch(':id/open-status')
    @Roles('ADMIN', 'RESTAURATEUR')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Ouvrir / fermer le restaurant manuellement' })
    updateOpenStatus(
        @Param('id') id: string,
        @Body() dto: UpdateOpenStatusDto,
        @FirebaseUser() fbUser: DecodedIdToken,
    ) {
        return this.service.updateOpenStatus(id, fbUser.uid, dto);
    }

    /**
     * PATCH /restaurants/:id/delivery-settings
     * Met à jour les paramètres de livraison
     */
    @Patch(':id/delivery-settings')
    @Roles('ADMIN', 'RESTAURATEUR')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Paramètres de livraison du restaurant' })
    updateDeliverySettings(
        @Param('id') id: string,
        @Body() dto: UpdateDeliverySettingsDto,
        @FirebaseUser() fbUser: DecodedIdToken  ,
    ) {
        return this.service.updateDeliverySettings(id, fbUser.uid, dto);
    }

    // ============ ENDPOINTS SPÉCIALITÉS ============

    /**
     * POST /restaurants/:id/specialties
     * Ajoute une spécialité au restaurant
     */
    @Post(':id/specialties')
    @Roles('ADMIN', 'RESTAURATEUR')
    @ApiOperation({ summary: 'Ajouter une spécialité' })
    addSpecialty(
        @Param('id') id: string,
        @Body() dto: AddSpecialtyDto,
        @FirebaseUser() fbUser: DecodedIdToken,
    ) {
        return this.service.addSpecialty(id, fbUser.uid, dto);
    }

    /**
     * DELETE /restaurants/:id/specialties/:specialtyId
     * Supprime une spécialité du restaurant
     */
    @Delete(':id/specialties/:specialtyId')
    @Roles('ADMIN', 'RESTAURATEUR')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Supprimer une spécialité' })
    removeSpecialty(
        @Param('id') id: string,
        @Param('specialtyId') specialtyId: string,
        @FirebaseUser() fbUser: DecodedIdToken,
    ) {
        return this.service.removeSpecialty(id, specialtyId, fbUser.uid);
    }

    // ============ ENDPOINTS HORAIRES D'OUVERTURE ============


    /**
     * PUT /restaurants/:id/operating-hours
     * Définit les horaires de la semaine (bulk upsert)
     */
    @Put(':id/operating-hours')
    @Roles('ADMIN', 'RESTAURATEUR')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Définir les horaires de la semaine (bulk)' })
    setOperatingHours(
        @Param('id') id: string,
        @Body() dto: SetOperatingHoursDto,
        @FirebaseUser() fbUser: DecodedIdToken,
    ) {
        return this.service.setOperatingHours(id, fbUser.uid, dto);
    }

    /**
     * PATCH /restaurants/:id/operating-hours/:dayOfWeek
     * Modifier un seul jour
     */
    @Patch(':id/operating-hours/:dayOfWeek')
    @Roles('ADMIN', 'RESTAURATEUR')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Modifier les horaires d\'un seul jour' })
    @ApiParam({ name: 'dayOfWeek', enum: DayOfWeek })
    updateOperatingHour(
        @Param('id') id: string,
        @Param('dayOfWeek') dayOfWeek: DayOfWeek,
        @Body() dto: UpdateOperatingHourDto,
        @FirebaseUser() fbUser: DecodedIdToken,
    ) {
        return this.service.updateOperatingHour(id, dayOfWeek, fbUser.uid, dto);
    }

    // ─── ANALYTICS / CLIENTS ───────────────────────────────────────────────────

    @Get(':id/orders/count')
    @Roles('RESTAURATEUR', 'ADMIN')
    @ApiOperation({ summary: 'Nombre de commandes du restaurant' })
    countOrders(@Param('id') id: string) {
        return this.service.countOrders(id);
    }
    // Endpoint pour récupérer les clients d'un restaurant spécifique
    @Get(':id/clients')
    @Roles('ADMIN', 'RESTAURATEUR')
    @ApiOperation({ summary: 'Clients distincts du restaurant (paginés)' })
    findClients(
        @Param('id') id: string,
        @Query('page') page = '1',
        @Query('limit') limit = '10',
    ) {
        return this.service.findClients(parseInt(page, 10), parseInt(limit, 10), id);
    }

    @Get(':id/clients/:userId/orders')
    @Roles('ADMIN', 'RESTAURATEUR')
    @ApiOperation({ summary: 'Commandes d\'un client pour ce restaurant' })
    async getClientOrders(
        @Param('id') restaurantId: string,
        @Param('userId') userId: string,
    ) {
        return this.service.findClientWithOrders(restaurantId, userId);
    }
}
