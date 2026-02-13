/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';

// Mapping des jours JS (0=Dimanche) vers l'enum DayOfWeek
const JS_DAY_TO_ENUM = [
    'DIMANCHE', // 0
    'LUNDI',    // 1
    'MARDI',    // 2
    'MERCREDI', // 3
    'JEUDI',    // 4
    'VENDREDI', // 5
    'SAMEDI',   // 6
] as const;

@Injectable()
export class RestaurantScheduleService {
    private readonly logger = new Logger(RestaurantScheduleService.name);

    constructor(private prisma: PrismaService) {}

    @Cron(CronExpression.EVERY_HOUR)
    async handleScheduleCheck() {
        this.logger.log('Checking restaurant schedules...');

        // Heure courante en UTC+1 (Afrique Centrale/Ouest, pas de DST)
        const now = new Date();
        const utcPlusOneMs = now.getTime() + 1 * 60 * 60 * 1000;
        const localDate = new Date(utcPlusOneMs);

        const currentDay = JS_DAY_TO_ENUM[localDate.getUTCDay()];
        const currentMinutes = localDate.getUTCHours() * 60 + localDate.getUTCMinutes();

        // Récupérer tous les restaurants qui ont des horaires et pas de manualOverride
        const restaurants = await this.prisma.restaurant.findMany({
            where: {
                manualOverride: false,
                operatingHours: { some: {} },
            },
            include: {
                operatingHours: {
                    where: { dayOfWeek: currentDay as any },
                },
            },
        });

        for (const restaurant of restaurants) {
            const todayHours = restaurant.operatingHours[0];

            // Pas d'horaire pour aujourd'hui → fermer
            if (!todayHours || todayHours.isClosed) {
                if (restaurant.isOpen) {
                    await this.prisma.restaurant.update({
                        where: { id: restaurant.id },
                        data: { isOpen: false },
                    });
                    this.logger.log(`Fermé: ${restaurant.nom} (pas d'horaire ou jour fermé)`);
                }
                continue;
            }

            const shouldBeOpen = this.isWithinOperatingHours(
                currentMinutes,
                todayHours.openTime,
                todayHours.closeTime,
            );

            // Ne mettre à jour que si le statut doit changer
            if (shouldBeOpen !== restaurant.isOpen) {
                await this.prisma.restaurant.update({
                    where: { id: restaurant.id },
                    data: { isOpen: shouldBeOpen },
                });
                this.logger.log(
                    `${shouldBeOpen ? 'Ouvert' : 'Fermé'}: ${restaurant.nom}`,
                );
            }
        }
    }

    /**
     * Vérifie si l'heure courante est dans la plage horaire.
     * Gère les horaires qui passent minuit (ex: 20:00 → 02:00).
     */
    private isWithinOperatingHours(currentMinutes: number, openTime: string, closeTime: string): boolean {
        const openMinutes = this.timeToMinutes(openTime);
        const closeMinutes = this.timeToMinutes(closeTime);

        if (closeMinutes > openMinutes) {
            // Cas normal: 08:00 → 22:00
            return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
        } else {
            // Cas minuit: 20:00 → 02:00 (closeMinutes < openMinutes)
            return currentMinutes >= openMinutes || currentMinutes < closeMinutes;
        }
    }

    private timeToMinutes(time: string): number {
        const [hours, minutes] = time.split(':').map(Number);
        return hours * 60 + minutes;
    }
}
