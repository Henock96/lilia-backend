/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DayOfWeek, SetOperatingHoursDto, UpdateOperatingHourDto } from './dto/operating-hours.dto';
import { RestaurantAccessService } from './restaurant-access.service';

/**
 * Gestion des horaires d'ouverture (extrait de RestaurantsService — LIL-145).
 *
 * CRUD sur OperatingHours. Le calcul ouvert/fermé selon ces horaires +
 * manualOverride vit dans le cron du module schedule, pas ici.
 */
@Injectable()
export class RestaurantHoursService {
  constructor(
    private prisma: PrismaService,
    private readonly access: RestaurantAccessService,
  ) {}

  /**
   * Bulk upsert des horaires de la semaine.
   * Fix : Promise.all au lieu d'awaits séquentiels dans la transaction.
   */
  async setOperatingHours(restaurantId: string, firebaseUid: string, dto: SetOperatingHoursDto) {
    const restaurant = await this.access.verifyOwnership(restaurantId, firebaseUid);

    const results = await this.prisma.$transaction(async (tx) => {
      // Tous les upserts en parallèle dans la même transaction
      const upserted = await Promise.all(
        dto.hours.map((hour) =>
          tx.operatingHours.upsert({
            where: {
              restaurantId_dayOfWeek: {
                restaurantId: restaurant.id,
                dayOfWeek: hour.dayOfWeek,
              },
            },
            update: {
              openTime: hour.openTime,
              closeTime: hour.closeTime,
              isClosed: hour.isClosed ?? false,
            },
            create: {
              restaurantId: restaurant.id,
              dayOfWeek: hour.dayOfWeek,
              openTime: hour.openTime,
              closeTime: hour.closeTime,
              isClosed: hour.isClosed ?? false,
            },
          }),
        ),
      );

      // Désactive le manualOverride — le cron reprend la main
      await tx.restaurant.update({
        where: { id: restaurant.id },
        data: { manualOverride: false },
      });

      return upserted;
    });

    return {
      data: results,
      message: 'Horaires d\'ouverture mis à jour',
    };
  }

  /**
   * Récupère les horaires d'ouverture d'un restaurant
   */
  async getOperatingHours(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });

    if (!restaurant) {
      throw new NotFoundException('Restaurant non trouvé');
    }

    const hours = await this.prisma.operatingHours.findMany({
      where: { restaurantId },
      orderBy: { dayOfWeek: 'asc' },
    });

    return {
      data: hours,
      count: hours.length,
    };
  }

  /**
   * Met à jour les horaires d'un seul jour
   */
  async updateOperatingHour(restaurantId: string, dayOfWeek: DayOfWeek, firebaseUid: string, dto: UpdateOperatingHourDto) {
    const restaurant = await this.access.verifyOwnership(restaurantId, firebaseUid);

    const existing = await this.prisma.operatingHours.findUnique({
      where: {
        restaurantId_dayOfWeek: {
          restaurantId: restaurant.id,
          dayOfWeek,
        },
      },
    });

    if (!existing) {
      throw new NotFoundException(`Aucun horaire défini pour ${dayOfWeek}`);
    }

    const updated = await this.prisma.operatingHours.update({
      where: { id: existing.id },
      data: {
        ...(dto.openTime !== undefined && { openTime: dto.openTime }),
        ...(dto.closeTime !== undefined && { closeTime: dto.closeTime }),
        ...(dto.isClosed !== undefined && { isClosed: dto.isClosed }),
      },
    });

    return {
      data: updated,
      message: `Horaires de ${dayOfWeek} mis à jour`,
    };
  }
}
