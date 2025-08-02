/* eslint-disable prettier/prettier */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { Roles } from 'src/firebase/roles.decorator';
import { RolesGuard } from 'src/firebase/roles.guard';
import { UserService } from './users.service';

@Controller('users')
export class UsersController {
    constructor(private readonly userService: UserService) {}

    // Endpoint pour récupérer toutes les commandes d'un utilisateur spécifique
    @Get(':id/orders')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    findUserOrders(@Param('id') id: string) {
        return this.userService.findUserOrders(id);
    }
}