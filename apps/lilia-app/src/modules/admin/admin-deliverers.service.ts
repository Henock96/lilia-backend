import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, DeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DelivererMissionStatus } from './dto/get-deliverer-missions.dto';

/**
 * Supervision livreurs côté admin (LIL-134) : liste, stats agrégées, historique
 * de missions. Extrait de `AdminService` (lectures Prisma uniquement).
 * `AdminService` y délègue — API publique inchangée.
 */
/**
 * Une ligne d'agrégat renvoyée par la requête de statistiques.
 *
 * Les `::int` / `::float` du SQL sont là pour une raison : PostgreSQL rend
 * `COUNT` en `bigint` et `SUM`/`AVG` en `numeric`, que le pilote traduit
 * respectivement en `BigInt` et en **chaîne**. Sans transtypage, `frozenCount`
 * serait un `BigInt` (que `JSON.stringify` refuse de sérialiser) et
 * `driverPayXaf` une chaîne qui se concaténerait au lieu de s'additionner.
 */
interface DelivererAggregateRow {
  deliveredCount: number;
  handledOrderValueXaf: number;
  frozenCount: number;
  /** `null` quand aucune course gelée — `SUM` d'un ensemble vide vaut `NULL`. */
  driverPayXaf: number | null;
  /** `null` quand aucune course n'a de durée mesurable. */
  avgDeliveryMinutes: number | null;
}

@Injectable()
export class AdminDeliverersService {
  constructor(private prisma: PrismaService) {}

  async getAllDeliverers(page = 1, limit = 20) {
    const [deliverers, total] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: 'LIVREUR' },
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          imageUrl: true,
          createdAt: true,
          deliveries: {
            select: { id: true, status: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 5, // 5 dernières livraisons
          },
          _count: { select: { deliveries: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where: { role: 'LIVREUR' } }),
    ]);

    return { data: deliverers, total, page, limit };
  }

  async getDelivererStats(delivererId: string) {
    const deliverer = await this.prisma.user.findUnique({
      where: { id: delivererId },
      select: { id: true, role: true },
    });
    if (!deliverer || deliverer.role !== 'LIVREUR') {
      throw new NotFoundException('Livreur introuvable');
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [grouped, aggregates, last30dDeliveries, lastDelivery] =
      await Promise.all([
        this.prisma.delivery.groupBy({
          by: ['status'],
          where: { delivererId },
          _count: { _all: true },
        }),
        // ⚠️ Agrégats calculés **par la base**, et non par un `findMany` suivi
        // de quatre `reduce` en mémoire.
        //
        // La version précédente chargeait TOUTES les courses livrées du livreur
        // depuis toujours, jointes à `Order`. Le coût de la fiche croissait
        // donc sans borne avec l'ancienneté : à vingt courses par jour, sept
        // mille lignes au bout d'un an, pour en tirer quatre nombres.
        //
        // Les `FILTER (WHERE …)` reproduisent exactement les filtres qui
        // vivaient dans le TypeScript, y compris les deux qui portent une règle
        // métier et non une commodité :
        //  · `driverEconomicsFrozenAt IS NOT NULL` — seule une course dont
        //    l'économie a été gelée entre dans la rémunération ; les autres
        //    sont comptées à part (`coursesWithoutEconomics`) au lieu d'être
        //    silencieusement additionnées à zéro ;
        //  · `pickedUpAt IS NOT NULL` — une course sans récupération n'a pas
        //    de durée, et l'inclure avec 0 tirerait la moyenne vers le bas.
        this.prisma.$queryRaw<DelivererAggregateRow[]>`
          SELECT
            COUNT(*)::int AS "deliveredCount",
            COALESCE(SUM(o."total"), 0)::int AS "handledOrderValueXaf",
            COUNT(*) FILTER (
              WHERE d."driverEconomicsFrozenAt" IS NOT NULL
            )::int AS "frozenCount",
            SUM(d."driverPayXaf") FILTER (
              WHERE d."driverEconomicsFrozenAt" IS NOT NULL
            )::int AS "driverPayXaf",
            AVG(
              EXTRACT(EPOCH FROM (d."deliveredAt" - d."pickedUpAt")) / 60
            ) FILTER (
              WHERE d."pickedUpAt" IS NOT NULL AND d."deliveredAt" IS NOT NULL
            )::float AS "avgDeliveryMinutes"
          FROM "Delivery" d
          JOIN "Order" o ON o."id" = d."orderId"
          WHERE d."delivererId" = ${delivererId}
            AND d."status" = ${DeliveryStatus.LIVRER}::"DeliveryStatus"
        `,
        this.prisma.delivery.count({
          where: { delivererId, createdAt: { gte: thirtyDaysAgo } },
        }),
        this.prisma.delivery.findFirst({
          where: {
            delivererId,
            status: DeliveryStatus.LIVRER,
            deliveredAt: { not: null },
          },
          orderBy: { deliveredAt: 'desc' },
          select: { deliveredAt: true },
        }),
      ]);

    const countOf = (status: DeliveryStatus) =>
      grouped.find((g) => g.status === status)?._count?._all ?? 0;

    const deliveredCount = countOf(DeliveryStatus.LIVRER);
    const failedCount = countOf(DeliveryStatus.ECHEC);
    const inProgressCount =
      countOf(DeliveryStatus.ASSIGNER) + countOf(DeliveryStatus.EN_TRANSIT);
    const totalDeliveries = grouped.reduce(
      (sum, g) => sum + (g._count?._all ?? 0),
      0,
    );

    const finished = deliveredCount + failedCount;
    const successRate =
      finished === 0
        ? 0
        : Math.round((deliveredCount / finished) * 100 * 100) / 100;

    /**
     * Valeur des commandes que ce livreur a portées — la somme de ce que les
     * CLIENTS ont payé.
     *
     * ⚠️ Ce n'est pas son revenu, et ce champ s'appelait pourtant
     * `totalRevenueXAF`. Sur la fiche d'un livreur, ce nom se lit « ce qu'il a
     * gagné » : les deux back-offices l'affichaient, chacun escorté d'un
     * commentaire d'avertissement — le signe qu'un libellé a besoin d'une note
     * de bas de page pour ne pas tromper est qu'il est faux.
     *
     * Ce que le livreur a réellement touché n'existe nulle part dans le
     * système (aucune colonne, aucune table). `driverPayXaf` le dit en toutes
     * lettres : `null` = inconnu. Ne jamais y mettre 0 — cela transformerait
     * « on ne sait pas » en « il n'a rien coûté ».
     */
    const agg = aggregates[0];
    const handledOrderValueXaf = agg?.handledOrderValueXaf ?? 0;

    // ── Ce que le livreur a RÉELLEMENT touché ─────────────────────────────
    //
    // Les 26 courses antérieures au 18/09/2026 n'ont aucune économie — aucun
    // backfill n'a été fait, parce qu'inventer des montants jamais versés
    // serait pire que l'absence. Le total dit donc combien de courses il
    // ignore : sans ce compteur, il se lirait comme exhaustif.
    // `null` et JAMAIS 0 : au déploiement, aucune fiche n'a d'économie et un 0
    // se lirait « ce livreur n'a rien gagné ». Le discriminant est le NOMBRE de
    // courses gelées, pas la somme — un livreur au salaire a légitimement
    // `SUM = 0` sur des courses parfaitement gelées.
    const frozenCount = agg?.frozenCount ?? 0;
    const driverPayXaf = frozenCount === 0 ? null : (agg?.driverPayXaf ?? 0);
    const coursesWithoutEconomics = (agg?.deliveredCount ?? 0) - frozenCount;

    const avgDeliveryMinutes =
      agg?.avgDeliveryMinutes == null
        ? null
        : Math.round(agg.avgDeliveryMinutes * 100) / 100;

    return {
      data: {
        totalDeliveries,
        deliveredCount,
        failedCount,
        inProgressCount,
        successRate,
        handledOrderValueXaf,
        /**
         * @deprecated Alias de `handledOrderValueXaf`, conservé le temps que
         * les deux back-offices migrent. Le nom laissait croire qu'il s'agit
         * du revenu du livreur ; c'est la valeur des commandes qu'il a
         * transportées. À retirer une fois les fronts à jour.
         */
        totalRevenueXAF: handledOrderValueXaf,
        /**
         * Rémunération réellement due au livreur sur ses courses livrées, en
         * XAF. `null` = aucune de ses courses ne porte d'économie connue.
         *
         * ⚠️ Somme des seules courses gelées. `coursesWithoutEconomics` dit
         * combien ce total ignore — l'afficher sans lui laisserait croire à un
         * cumul exhaustif.
         */
        driverPayXaf,
        /** Courses livrées sans économie connue (antérieures au 18/09/2026). */
        coursesWithoutEconomics,
        avgDeliveryMinutes,
        last30dDeliveries,
        lastDeliveryAt: lastDelivery?.deliveredAt ?? null,
      },
    };
  }

  async getDelivererMissions(
    delivererId: string,
    status?: DelivererMissionStatus,
    page = 1,
    limit = 20,
  ) {
    const deliverer = await this.prisma.user.findUnique({
      where: { id: delivererId },
      select: { id: true, role: true },
    });
    if (!deliverer || deliverer.role !== 'LIVREUR') {
      throw new NotFoundException('Livreur introuvable');
    }

    const where: Prisma.DeliveryWhereInput = {
      delivererId,
      ...(status ? { status } : {}),
    };

    const [deliveries, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          orderId: true,
          status: true,
          createdAt: true,
          pickedUpAt: true,
          deliveredAt: true,
          order: {
            select: {
              total: true,
              restaurant: { select: { nom: true } },
              user: { select: { nom: true } },
            },
          },
        },
      }),
      this.prisma.delivery.count({ where }),
    ]);

    const data = deliveries.map((d) => ({
      id: d.id,
      orderId: d.orderId,
      status: d.status,
      restaurantName: d.order?.restaurant?.nom ?? null,
      clientName: d.order?.user?.nom ?? null,
      totalXAF: d.order?.total ?? 0,
      acceptedAt: d.pickedUpAt ?? null,
      deliveredAt: d.deliveredAt ?? null,
      createdAt: d.createdAt,
    }));

    const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;

    return {
      data,
      meta: { total, page, limit, totalPages },
    };
  }
}
