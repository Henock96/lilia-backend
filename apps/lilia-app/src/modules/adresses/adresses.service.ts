import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAdresseDto } from './dto/create-adresse.dto';
import { UpdateAdresseDto } from './dto/update-adresse.dto';

@Injectable()
export class AdressesService {
  constructor(private prisma: PrismaService) {}

  private async getUserOrThrow(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');
    return user;
  }

  async create(firebaseUid: string, createAdresseDto: CreateAdresseDto) {
    const user = await this.getUserOrThrow(firebaseUid);

    const adresse = await this.prisma.adresses.create({
      data: {
        ...createAdresseDto,
        userId: user.id,
      },
      include: { quartier: true },
    });
    return { data: adresse, message: 'Adresse créée avec succès' };
  }

  async findAll(firebaseUid: string) {
    const user = await this.getUserOrThrow(firebaseUid);

    const adresses = await this.prisma.adresses.findMany({
      where: { userId: user.id },
      include: { quartier: true },
      orderBy: { createdAt: 'desc' },
    });
    return { data: adresses, count: adresses.length };
  }

  async findOne(id: string, firebaseUid: string) {
    const user = await this.getUserOrThrow(firebaseUid);

    // 1 seule requête au lieu de 2
    const adresse = await this.prisma.adresses.findFirst({
      where: { id, userId: user.id },
      include: { quartier: true },
    });

    if (!adresse) {
      throw new NotFoundException(
        'Adresse non trouvée ou ne vous appartient pas.',
      );
    }
    return { data: adresse };
  }

  async update(id: string, firebaseUid: string, dto: UpdateAdresseDto) {
    await this.findOne(id, firebaseUid); // Vérifie que l'adresse existe et appartient à l'utilisateur
    const updated = await this.prisma.adresses.update({
      where: { id },
      data: dto,
      include: { quartier: true },
    });
    return { data: updated, message: 'Adresse mise à jour' };
  }

  async remove(id: string, firebaseUid: string) {
    await this.findOne(id, firebaseUid); // vérifie propriété
    await this.prisma.adresses.delete({ where: { id } });
    return { message: 'Adresse supprimée' };
  }

  /**
   * Définit une adresse comme adresse par défaut.
   * Désactive les autres adresses par défaut du même user.
   */
  async setDefault(id: string, firebaseUid: string) {
    const user = await this.getUserOrThrow(firebaseUid);

    const adresse = await this.prisma.adresses.findFirst({
      where: { id, userId: user.id },
    });
    if (!adresse) throw new NotFoundException('Adresse non trouvée.');

    // Transaction : reset tout puis set celle-ci
    await this.prisma.$transaction([
      this.prisma.adresses.updateMany({
        where: { userId: user.id },
        data: { isDefault: false },
      }),
      this.prisma.adresses.update({
        where: { id },
        data: { isDefault: true },
      }),
    ]);

    return { message: 'Adresse par défaut définie' };
  }
}
