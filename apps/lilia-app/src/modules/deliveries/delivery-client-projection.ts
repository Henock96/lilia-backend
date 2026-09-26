import { DeliveryStatus } from '@prisma/client';

/**
 * Ce que le CLIENT voit de son livreur, selon l'état de la course.
 *
 * F3-12.0 (H7 / I16) — `GET /deliveries/by-order/:orderId` servait au client
 * le nom complet, le téléphone, la photo et la dernière position du livreur
 * **quel que soit le statut** : dès l'assignation, bien avant que le repas ne
 * quitte le comptoir, et encore après la livraison. Le dispatch rendrait la
 * fuite systématique (chaque course acceptée l'est avant le départ).
 *
 * | Course               | Identité        | Téléphone | Photo | Position |
 * |----------------------|-----------------|-----------|-------|----------|
 * | `EN_TRANSIT`         | nom complet     | ✅        | ✅    | ✅       |
 * | toute autre          | premier mot     | —         | —     | —        |
 *
 * Seul `EN_TRANSIT` justifie le contact : le livreur roule vers le client avec
 * son repas, et le client doit pouvoir l'appeler pour le guider. Avant, rien à
 * se dire ; après (`LIVRER`, écran de notation), le prénom suffit.
 *
 * ⚠️ « Prénom » = **premier mot** de `User.nom`, seul champ d'identité en
 * base. À Brazzaville, le nom de famille précède souvent le prénom : ce mot
 * peut donc être l'un ou l'autre. C'est une limite assumée — un seul mot en
 * dit toujours moins que le nom complet, ce qui est l'objet de la règle.
 *
 * Les clés restent présentes (valeur `null`) : `lilia-app` les lit une par une
 * en nullable, et une clé absente ne s'y distingue pas d'une clé nulle.
 */
export function projectDeliveryForClient<
  D extends {
    status: DeliveryStatus;
    lastLatitude: number | null;
    lastLongitude: number | null;
    lastPositionAt: Date | null;
    deliverer: {
      id: string;
      nom: string | null;
      phone: string | null;
      imageUrl: string | null;
    } | null;
  },
>(delivery: D): D {
  if (delivery.status === DeliveryStatus.EN_TRANSIT) return delivery;

  return {
    ...delivery,
    lastLatitude: null,
    lastLongitude: null,
    lastPositionAt: null,
    deliverer: delivery.deliverer
      ? {
          ...delivery.deliverer,
          nom: firstWord(delivery.deliverer.nom),
          phone: null,
          imageUrl: null,
        }
      : null,
  };
}

function firstWord(nom: string | null): string | null {
  const word = nom?.trim().split(/\s+/)[0];
  return word ? word : null;
}
