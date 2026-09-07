/**
 * « La carte de ce vendeur a changé. »
 *
 * Un seul événement pour toutes les écritures du catalogue — produit, section,
 * menu du jour, image, ordre — et volontairement **sans détail** de ce qui a
 * changé. Son unique consommateur invalide un cache par vendeur : savoir *quel*
 * champ a bougé ne changerait rien à ce qu'il fait, et l'inviterait à
 * n'invalider qu'une partie de la page, c'est-à-dire à réinventer côté serveur
 * une carte de dépendances que Next gère déjà par étiquettes.
 *
 * ⚠️ Ce n'est **pas** un événement métier : il ne notifie personne, ne déclenche
 * aucun mouvement d'argent, et sa perte est sans conséquence — le cache expire
 * de lui-même en quelques minutes. Ne rien y accrocher qui doive être garanti :
 * ce qui doit l'être passe par `OutboxEvent`, écrit dans la transaction.
 */
export class CatalogChangedEvent {
  constructor(
    public readonly restaurantId: string,
    /** Ce qui a changé — journalisation seulement, jamais une décision. */
    public readonly reason: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

/** Nom d'événement unique, pour ne pas le recopier dans chaque service. */
export const CATALOG_CHANGED = 'catalog.changed';
