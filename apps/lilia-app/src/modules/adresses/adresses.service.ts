import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
    await this.assertQuartierMatchesCity(
      createAdresseDto.quartierId,
      createAdresseDto.ville,
    );

    const adresse = await this.prisma.adresses.create({
      data: {
        ...createAdresseDto,
        userId: user.id,
      },
      include: { quartier: true },
    });
    return { data: adresse, message: 'Adresse créée avec succès' };
  }

  /**
   * Cohérence quartier ↔ ville (atténuation M17 — audit du 28/08/2026).
   *
   * En mode `ZONE_BASED`, les frais de livraison dérivent du `quartierId` de
   * l'adresse — un champ libre du DTO, sans aucun lien vérifié avec `rue` et
   * `ville`. Le client pouvait donc déclarer le quartier le moins cher.
   *
   * On ne peut pas trancher sans géocodage (hors périmètre), mais on peut au
   * moins refuser un `quartierId` inexistant et un quartier situé dans une
   * autre ville. Le contrôle final reste humain : le vendeur voit l'adresse
   * complète **et** le quartier déclaré avant d'accepter la commande.
   */
  private async assertQuartierMatchesCity(
    quartierId: string | undefined,
    ville: string | undefined,
  ): Promise<void> {
    if (!quartierId) return;

    const quartier = await this.prisma.quartier.findUnique({
      where: { id: quartierId },
      select: { nom: true, ville: true },
    });
    if (!quartier) {
      throw new BadRequestException('Quartier inconnu.');
    }

    if (
      ville &&
      quartier.ville.trim().toLowerCase() !== ville.trim().toLowerCase()
    ) {
      throw new BadRequestException(
        `Le quartier « ${quartier.nom} » est à ${quartier.ville}, pas à ${ville}.`,
      );
    }
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
    const existing = await this.findOne(id, firebaseUid); // Vérifie que l'adresse existe et appartient à l'utilisateur
    // Même contrôle qu'à la création (M17) : sans lui, il suffisait de créer
    // une adresse valide puis d'en changer le quartier.
    await this.assertQuartierMatchesCity(
      dto.quartierId,
      dto.ville ?? existing.data?.ville,
    );
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
