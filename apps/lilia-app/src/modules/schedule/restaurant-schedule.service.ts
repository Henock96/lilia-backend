/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

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

    /**
     * Ouverture / fermeture automatique des vendeurs.
     *
     * Cadence **à la minute** : les `OperatingHours` sont stockés en "HH:mm" et
     * comparés à la minute près. Avec un passage horaire, un vendeur ouvrant à
     * 08h30 restait marqué fermé jusqu'à 09h00 — 30 min de commandes refusées
     * chaque matin.
     */
    @Cron(CronExpression.EVERY_MINUTE)
    async handleScheduleCheck() {
        // Heure courante en UTC+1 (Afrique Centrale/Ouest, pas de DST)
        const now = new Date();
        const utcPlusOneMs = now.getTime() + 1 * 60 * 60 * 1000;
        const localDate = new Date(utcPlusOneMs);

        const currentDayIndex = localDate.getUTCDay();
        const currentDay = JS_DAY_TO_ENUM[currentDayIndex];
        // Veille : nécessaire pour les horaires qui traversent minuit (20h → 02h).
        // À 01h00 on est déjà "demain", mais le vendeur doit rester ouvert.
        const previousDay = JS_DAY_TO_ENUM[(currentDayIndex + 6) % 7];
        const currentMinutes = localDate.getUTCHours() * 60 + localDate.getUTCMinutes();

        const restaurants = await this.prisma.restaurant.findMany({
            where: {
                manualOverride: false,
                operatingHours: { some: {} },
            },
            select: {
                id: true,
                nom: true,
                isOpen: true,
                operatingHours: {
                    where: { dayOfWeek: { in: [currentDay, previousDay] as any } },
                    select: { dayOfWeek: true, openTime: true, closeTime: true, isClosed: true },
                },
            },
        });

        const toOpen: string[] = [];
        const toClose: string[] = [];

        for (const restaurant of restaurants) {
            const todayHours = restaurant.operatingHours.find(
                (h) => h.dayOfWeek === currentDay,
            );
            const yesterdayHours = restaurant.operatingHours.find(
                (h) => h.dayOfWeek === previousDay,
            );

            const shouldBeOpen =
                this.matchesTodayHours(currentMinutes, todayHours) ||
                this.matchesOvernightFromYesterday(currentMinutes, yesterdayHours);

            if (shouldBeOpen === restaurant.isOpen) continue;

            (shouldBeOpen ? toOpen : toClose).push(restaurant.id);
            this.logger.log(`${shouldBeOpen ? 'Ouvert' : 'Fermé'}: ${restaurant.nom}`);
        }

        // Deux requêtes groupées au lieu d'une par vendeur — la cadence à la
        // minute rend le N+1 précédent intenable à l'échelle.
        if (toOpen.length) {
            await this.prisma.restaurant.updateMany({
                where: { id: { in: toOpen } },
                data: { isOpen: true },
            });
        }
        if (toClose.length) {
            await this.prisma.restaurant.updateMany({
                where: { id: { in: toClose } },
                data: { isOpen: false },
            });
        }
    }

    /** Le vendeur est-il dans sa plage d'ouverture du jour ? */
    private matchesTodayHours(
        currentMinutes: number,
        hours?: { openTime: string; closeTime: string; isClosed: boolean },
    ): boolean {
        if (!hours || hours.isClosed) return false;
        return this.isWithinOperatingHours(currentMinutes, hours.openTime, hours.closeTime);
    }

    /**
     * Cas minuit-traversal : l'horaire de la veille (20h → 02h) déborde sur le
     * jour courant. On n'est concerné que si l'on est avant l'heure de fermeture.
     */
    private matchesOvernightFromYesterday(
        currentMinutes: number,
        hours?: { openTime: string; closeTime: string; isClosed: boolean },
    ): boolean {
        if (!hours || hours.isClosed) return false;
        const openMinutes = this.timeToMinutes(hours.openTime);
        const closeMinutes = this.timeToMinutes(hours.closeTime);
        if (closeMinutes >= openMinutes) return false; // pas de traversée de minuit
        return currentMinutes < closeMinutes;
    }

    /**
     * Reset quotidien du stock : remet stockRestant = stockQuotidien
     * pour tous les produits et menus actifs ayant un stockQuotidien défini.
     * S'exécute tous les jours à 5h du matin (UTC+1).
     */
    @Cron('0 4 * * *') // 4h UTC = 5h UTC+1
    async handleDailyStockReset() {
        this.logger.log('Resetting daily stock for products and menus...');

        // LIL-112 : ne pas reset les produits stockMode=PERMANENT (cavistes,
        // épiceries — ils gèrent un stock réel, pas une capacité quotidienne).
        const productResult = await this.prisma.$executeRaw`
            UPDATE "Product" SET "stockRestant" = "stockQuotidien"
            WHERE "stockQuotidien" IS NOT NULL
              AND "stockMode" = 'DAILY'
        `;
        this.logger.log(`Stock reset for ${productResult} products (DAILY only)`);

        const menuResult = await this.prisma.$executeRaw`
            UPDATE "MenuDuJour" SET "stockRestant" = "stockQuotidien"
            WHERE "stockQuotidien" IS NOT NULL AND "isActive" = true
        `;
        this.logger.log(`Stock reset for ${menuResult} menus`);
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
