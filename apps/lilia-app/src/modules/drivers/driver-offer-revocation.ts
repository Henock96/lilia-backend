import { Prisma, PrismaClient } from '@prisma/client';

/**
 * **Révocation des offres d'un livreur** (F3-12.1, patron §8.4 de la Discovery).
 *
 * Ban, changement de rôle, désactivation, passage `OFFLINE`, suppression de
 * compte : tous rendent un livreur inéligible, et aucune offre `OFFERED` ne
 * doit lui survivre. Deux temps, jamais un seul :
 *
 * ```
 * tx1 : R3  cancelOpenOffers()        ← AVANT le verrou du livreur (R4)
 *       R4  lockDriverRow ; garde ; écriture
 *       COMMIT
 * tx2 : R3  sweepRevokedOffers()      ← après le commit, avant la réponse HTTP
 * ```
 *
 * Pourquoi pas un seul balayage APRÈS R4 dans tx1 : l'acceptation d'une offre
 * tient R3 et attend R4 — re-prendre R3 en tenant R4 formerait un cycle.
 * Pourquoi pas tx1 seul : une offre insérée par une recherche concurrente, pas
 * encore commise, est invisible à l'`UPDATE` de tx1. La recherche vérifie le
 * livreur sous R4 APRÈS son insertion (§8.3) : soit elle voit l'état révoqué
 * et s'annule, soit elle a commis avant tx1 — et tx2 la voit.
 *
 * Les offres ne sont créées que dispatch allumé (trigger
 * `DeliveryOffer_dispatch_enabled`) : aujourd'hui, ces deux fonctions ne
 * trouvent rien, et c'est voulu — elles doivent être en place AVANT.
 */

/** tx1, rang R3 : retire toutes les offres ouvertes du livreur. */
export async function cancelOpenOffers(
  tx: Prisma.TransactionClient,
  driverId: string,
): Promise<number> {
  return tx.$executeRaw`
    UPDATE "DeliveryOffer" SET status = 'CANCELLED', "respondedAt" = now()
     WHERE "driverId" = ${driverId} AND status = 'OFFERED'
  `;
}

/**
 * tx2, R3 seul (une ligne au plus, index `DeliveryOffer_open_per_driver_uq`) :
 * retire l'offre ouverte d'un livreur qui n'est plus éligible, lu en base.
 *
 * La condition est l'éligibilité complète, pas la cause de l'appel : un seul
 * balayage vaut pour tous les gestes, et le filet du tick (12.5) appliquera
 * le même à tous les livreurs.
 */
export async function sweepRevokedOffers(
  db: PrismaClient | Prisma.TransactionClient,
  driverId: string,
): Promise<number> {
  return db.$executeRaw`
    UPDATE "DeliveryOffer" o SET status = 'CANCELLED', "respondedAt" = now()
      FROM "User" u
     WHERE o."driverId" = ${driverId} AND o.status = 'OFFERED'
       AND u.id = o."driverId"
       AND (u."statusUser" <> 'ACTIVE'
            OR u.role <> 'LIVREUR'
            OR u."driverStatus" IS DISTINCT FROM 'AVAILABLE'
            OR u."banPendingAt" IS NOT NULL
            OR NOT EXISTS (SELECT 1 FROM "DriverProfile" p
                            WHERE p."userId" = u.id AND p."isActive"))
  `;
}
