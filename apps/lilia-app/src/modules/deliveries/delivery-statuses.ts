import { DeliveryStatus } from '@prisma/client';

/**
 * Statuts pour lesquels une course **occupe** son livreur.
 *
 * `ACCEPTER` en fait partie : le livreur a pris la mission et se rend au
 * restaurant. L'omettre ferait disparaître la course de ses missions actives
 * entre l'acceptation et la récupération, le laisserait passer `AVAILABLE` en
 * pleine course, et le compterait comme disponible côté vendeur.
 *
 * Constante partagée volontairement : la liste était dupliquée à quatre
 * endroits, et c'est précisément ce genre d'oubli qui laisse passer une
 * incohérence de statut.
 */
export const ACTIVE_DELIVERY_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.ASSIGNER,
  DeliveryStatus.ACCEPTER,
  DeliveryStatus.EN_TRANSIT,
];
