import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdressesService } from './adresses.service';
import { CreateAdresseDto } from './dto/create-adresse.dto';
import { UpdateAdresseDto } from './dto/update-adresse.dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { DecodedIdToken } from 'firebase-admin/auth';

/**
 * Guards globaux actifs — pas besoin de @UseGuards().
 * Toutes les routes adresses nécessitent un utilisateur connecté.
 */
@ApiTags('Adresses')
@ApiBearerAuth()
@Controller('adresses')
export class AdressesController {
  constructor(private readonly adressesService: AdressesService) {}

  @Post()
  @ApiOperation({ summary: 'Créer une adresse' })
  create(
    @Body() createAdresseDto: CreateAdresseDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.adressesService.create(fbUser.uid, createAdresseDto);
  }

  @Get()
  @ApiOperation({ summary: 'Mes adresses' })
  findAll(@FirebaseUser() fbUser: DecodedIdToken) {
    return this.adressesService.findAll(fbUser.uid);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Une adresse par ID' })
  findOne(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.adressesService.findOne(id, fbUser.uid);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Mettre à jour une adresse' })
  update(
    @Param('id') id: string,
    @Body() updateAdresseDto: UpdateAdresseDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.adressesService.update(id, fbUser.uid, updateAdresseDto);
  }

  @Patch(':id/default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Définir comme adresse par défaut' })
  setDefault(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.adressesService.setDefault(id, fbUser.uid);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer une adresse' })
  remove(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.adressesService.remove(id, fbUser.uid);
  }
}
