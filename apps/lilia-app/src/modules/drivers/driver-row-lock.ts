import { DriverStatus, Prisma, Role, StatusUser } from '@prisma/client';

/**
 * Verrouille la ligne `User` d'un livreur (`SELECT … FOR NO KEY UPDATE`) et rend ce
 * qui décide de son éligibilité, ou `null` si le compte n'existe pas.
 *
 * **Le verrou du livreur** (F3-12, ordre global des verrous, rang R4) :
 *
 * ```
 * R1 Order → R2 Delivery → R3 DeliveryOffer → R4 User → R5 DriverProfile
 * ```
 *
 * Acceptation d'une course, changement de disponibilité, désactivation :
 * tous décident sur l'état d'un même livreur. Ils étaient arbitrés par des
 * lectures faites HORS transaction, suivies d'une écriture sans condition — un
 * livreur qui venait d'accepter une course pouvait être réécrit `AVAILABLE`
 * (et donc recevoir une seconde course) ou `OFFLINE` et désactivé en pleine
 * mission. Ils prennent désormais tous cette ligne avant de décider : le
 * second attend le commit du premier, puis relit un état à jour.
 *
 * ⚠️ Rang R4 : ne jamais prendre ensuite un verrou `Order` ou `Delivery` dans
 * la même transaction (interblocage). `DriverProfile` (R5) vient APRÈS.
 *
 * ## `FOR NO KEY UPDATE`, et non `FOR UPDATE` (F3-12.1)
 *
 * Écrire `Delivery.delivererId` (ou insérer une ligne de journal) fait poser
 * par PostgreSQL, au titre de la clé étrangère, un `FOR KEY SHARE` sur la
 * ligne `User` visée — AVANT tout verrou pris par ce module. `FOR UPDATE` est
 * incompatible avec `FOR KEY SHARE` : deux réassignations croisées
 * (Z : A→B ∥ X : B→A) tenaient chacune le `KEY SHARE` d'un livreur et
 * attendaient le `FOR UPDATE` de l'autre — interblocage réel (40P01), prouvé
 * par `driver-release.int-spec.ts`. `FOR NO KEY UPDATE` exclut toujours toute
 * autre écriture de la ligne (c'est le verrou que prend un `UPDATE` ordinaire)
 * mais laisse passer les contrôles de clé étrangère, qui ne la modifient pas.
 */
export async function lockDriverRow(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<{
  role: Role;
  statusUser: StatusUser;
  driverStatus: DriverStatus | null;
} | null> {
  const rows = await tx.$queryRaw<
    { role: Role; statusUser: StatusUser; driverStatus: DriverStatus | null }[]
  >`
    SELECT role, "statusUser", "driverStatus"
      FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE
  `;
  return rows[0] ?? null;
}
