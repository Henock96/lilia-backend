import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AdressesService } from './adresses.service';
import { CreateAdresseDto } from './dto/create-adresse.dto';
import { UpdateAdresseDto } from './dto/update-adresse.dto';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';

@UseGuards(FirebaseAuthGuard)
@Controller('adresses')
export class AdressesController {
  constructor(private readonly adressesService: AdressesService) {}

  @Post()
  create(@Body() createAdresseDto: CreateAdresseDto, @Req() req) {
    return this.adressesService.create(req.user.uid, createAdresseDto);
  }

  @Get()
  findAll(@Req() req) {
    return this.adressesService.findAll(req.user.uid);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req) {
    return this.adressesService.findOne(id, req.user.uid);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateAdresseDto: UpdateAdresseDto,
    @Req() req,
  ) {
    return this.adressesService.update(id, req.user.uid, updateAdresseDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req) {
    return this.adressesService.remove(id, req.user.uid);
  }
}
