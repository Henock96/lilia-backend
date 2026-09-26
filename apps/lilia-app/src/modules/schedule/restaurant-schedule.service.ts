/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OnboardingStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CronLockService } from '../../common/locks/cron-lock.service';
import { VendorOpeningService } from '../vendors/vendor-opening.service';

@Injectable()
export class RestaurantScheduleService {
    private readonly logger = new Logger(RestaurantScheduleService.name);

    constructor(
        private prisma: PrismaService,
        private readonly cronLock: CronLockService,
        private readonly opening: VendorOpeningService,
    ) {}

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
        // Fix M8 : deux instances ouvraient/fermaient les mêmes vendeurs à la
        // même minute. Idempotent, mais deux fois le travail — et deux fois
        // les écritures. TTL court : le job tourne chaque minute.
        await this.cronLock.runExclusively('restaurant-open-close', 50, () =>
            this.handleScheduleCheckUnlocked(),
        );
    }

    /**
     * F3-03 — la décision vient de `decideOpening` (horaires, pause datée,
     * congés, jours fériés, interrupteur manuel), la même règle que le
     * checkout. Les vendeurs en `manualOverride` sont chargés aussi : une
     * pause ou un congé les ferme malgré l'interrupteur, qui garde la main
     * sinon (la règle rend alors l'état posé à la main, inchangé).
     *
     * Sans horaires, un vendeur est fermé : il n'est plus exclu de
     * l'évaluation comme il l'était autrefois, où il gardait `isOpen = true`
     * en permanence.
     */
    private async handleScheduleCheckUnlocked() {
        // Un vendeur encore en configuration n'a pas à être ouvert par un
        // automate : son ouverture est décidée à l'activation.
        const decisions = await this.opening.decideMany({
            onboardingStatus: OnboardingStatus.ACTIVATED,
        });

        const toOpen: string[] = [];
        const toClose: string[] = [];
        const releaseManual: string[] = [];

        for (const { vendor, decision } of decisions) {
            // Une fermeture datée relâche l'interrupteur manuel : sinon, à sa
            // fin, l'état « fermé » qu'elle a posé passerait pour un choix du
            // vendeur et la boutique ne rouvrirait jamais.
            if (
                vendor.manualOverride &&
                ['PAUSED', 'CLOSURE', 'HOLIDAY'].includes(decision.reason)
            ) {
                releaseManual.push(vendor.id);
            }
            if (decision.open === vendor.isOpen) continue;
            (decision.open ? toOpen : toClose).push(vendor.id);
            this.logger.log(
                `${decision.open ? 'Ouvert' : 'Fermé'}: ${vendor.nom} (${decision.reason})`,
            );
        }

        // Requêtes groupées, jamais une par vendeur : le job tourne à la minute.
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
        if (releaseManual.length) {
            await this.prisma.restaurant.updateMany({
                where: { id: { in: releaseManual } },
                data: { manualOverride: false },
            });
        }
    }

    /**
     * Reset quotidien du stock : remet stockRestant = stockQuotidien
     * pour tous les produits et menus actifs ayant un stockQuotidien défini.
     * S'exécute tous les jours à 5h du matin (UTC+1).
     */
    @Cron('0 4 * * *') // 4h UTC = 5h UTC+1
    async handleDailyStockReset() {
        await this.cronLock.runExclusively('daily-stock-reset', 600, () =>
            this.handleDailyStockResetUnlocked(),
        );
    }

    private async handleDailyStockResetUnlocked() {
        this.logger.log('Resetting daily stock for products and menus...');

        // LIL-112 : ne pas reset les produits stockMode=PERMANENT (cavistes,
        // épiceries — ils gèrent un stock réel, pas une capacité quotidienne).
        // F3-10 — la politique (`DAILY_QUOTA`) remplace `stockMode = 'DAILY'` ;
        // le CHECK `Product_stock_policy_consistent` garantit que le quota est
        // renseigné. `stockResetAt` date ce renouvellement : une commande
        // réservée avant lui ne sera pas restituée dans le quota du jour (le
        // reset a déjà effacé sa réservation). Les formats n'y changent rien :
        // le quota est en unités de stock (« 20 bouteilles par jour »).
        const productResult = await this.prisma.$executeRaw`
            UPDATE "Product"
               SET "stockRestant" = "stockQuotidien",
                   "stockResetAt" = timezone('UTC', now())
             WHERE "stockPolicy" = 'DAILY_QUOTA'
        `;
        this.logger.log(`Stock reset for ${productResult} products (DAILY_QUOTA only)`);

        const menuResult = await this.prisma.$executeRaw`
            UPDATE "MenuDuJour" SET "stockRestant" = "stockQuotidien"
            WHERE "stockQuotidien" IS NOT NULL AND "isActive" = true
        `;
        this.logger.log(`Stock reset for ${menuResult} menus`);
    }
}
