import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateAdresseDto } from './dto/create-adresse.dto';
import { UpdateAdresseDto } from './dto/update-adresse.dto';

@Injectable()
export class AdressesService {
  constructor(private prisma: PrismaService) {}

  async create(userUid: string, createAdresseDto: CreateAdresseDto) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid: userUid } });
    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    return this.prisma.adresses.create({
      data: {
        ...createAdresseDto,
        userId: user.id,
      },
    });
  }

  async findAll(userUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid: userUid } });
    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }
    return this.prisma.adresses.findMany({
      where: { userId: user.id },
    });
  }

  async findOne(id: string, userUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid: userUid } });
    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }
    const adresse = await this.prisma.adresses.findUnique({ where: { id } });
    if (!adresse || adresse.userId !== user.id) {
      throw new NotFoundException("Adresse non trouvée ou ne vous appartient pas.");
    }
    return adresse;
  }

  async update(id: string, userUid: string, updateAdresseDto: UpdateAdresseDto) {
    await this.findOne(id, userUid); // Vérifie que l'adresse existe et appartient à l'utilisateur
    return this.prisma.adresses.update({
      where: { id },
      data: updateAdresseDto,
    });
  }

  async remove(id: string, userUid: string) {
    await this.findOne(id, userUid); // Vérifie que l'adresse existe et appartient à l'utilisateur
    return this.prisma.adresses.delete({ where: { id } });
  }
}
