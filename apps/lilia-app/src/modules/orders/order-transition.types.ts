/**
 * Vocabulaire des transitions de commande — acteur et provenance.
 *
 * Deux unions TypeScript plutôt que deux enums Prisma. La raison n'est pas le
 * confort : ajouter une valeur à un type énuméré PostgreSQL impose un
 * `ALTER TYPE … ADD VALUE`, qui n'est **pas transactionnel**. Ce dépôt a déjà
 * vu une migration mourir dessus et laisser toute la production en `DRAFT`
 * (`20260830120000_vendor_onboarding`). Les colonnes sont donc en `TEXT`, et ce
 * fichier est la seule source de valeurs admises — `order-transition.spec.ts`
 * échoue si le code en produit une autre.
 */

/**
 * Qui a fait la transition.
 *
 * Reprend `OrderActor` de la machine à états, plus `SYSTEM` pour ce qu'aucun
 * humain n'a déclenché : l'expiration d'une commande impayée, la confirmation
 * d'un encaissement par webhook, le règlement d'une commande à zéro.
 *
 * ⚠️ `SYSTEM` n'est volontairement **pas** ajouté à l'enum Prisma `Role`. Ce
 * n'est pas un rôle du RBAC : lui en donner un changerait le modèle
 * d'autorisation de toute l'application pour un besoin d'historique.
 */
export const ORDER_TRANSITION_ACTORS = [
  'CLIENT',
  'RESTAURATEUR',
  'LIVREUR',
  'ADMIN',
  'SYSTEM',
] as const;

export type OrderTransitionActor = (typeof ORDER_TRANSITION_ACTORS)[number];

/**
 * D'où vient le geste.
 *
 * C'est ce qui sépare une transition **humaine** d'un automatisme — donc ce qui
 * rendra calculable le taux d'acceptation vendeur, qu'aucune donnée ne permet
 * d'établir aujourd'hui : une commande passée en préparation depuis
 * l'application du vendeur et une commande débloquée par un administrateur
 * produisent aujourd'hui exactement la même trace, c'est-à-dire aucune.
 *
 * `PaymentEventSource` n'a pas été réutilisé : ses valeurs (`INITIATION`,
 * `CLIENT_POLL`, `RECONCILIATION`) décrivent le cycle de vie d'une transaction
 * de paiement, pas l'origine d'un geste sur une commande, et il lui manque
 * `APP`, `ADMIN_APP` et `CRON`. Le réutiliser aurait forcé des valeurs fausses.
 */
export const ORDER_TRANSITION_SOURCES = [
  /** Application mobile du client, du vendeur ou du livreur. */
  'APP',
  /** Back-office — `lilia-food-admin` ou `lilia-food-web/apps/admin`. */
  'ADMIN_APP',
  /** Décision prise par le serveur lui-même, sans appel entrant. */
  'BACKEND',
  /** Callback d'un prestataire de paiement. */
  'WEBHOOK',
  /** Interrogation du prestataire déclenchée par le client. */
  'POLLING',
  /** Tâche planifiée (expiration, réconciliation). */
  'CRON',
] as const;

export type OrderTransitionSource = (typeof ORDER_TRANSITION_SOURCES)[number];

/**
 * Traduit un rôle Prisma en acteur de transition.
 *
 * Rend `null` pour un rôle inconnu plutôt que de retomber sur une valeur par
 * défaut : un acteur inventé dans un journal d'audit est pire qu'un refus.
 */
export function actorFromRole(role: string): OrderTransitionActor | null {
  return (ORDER_TRANSITION_ACTORS as readonly string[]).includes(role)
    ? (role as OrderTransitionActor)
    : null;
}

/**
 * Provenance déduite du rôle de l'auteur.
 *
 * Un `ADMIN` agit depuis un back-office, tout le monde d'autre depuis une
 * application mobile. C'est une approximation assumée — le serveur ne reçoit
 * aucun en-tête qui identifie le client — mais elle est exacte dans les faits :
 * aucune application mobile ne propose les gestes réservés à l'ADMIN, et le
 * back-office web n'est utilisé que par des comptes ADMIN.
 */
export function sourceFromRole(role: string): OrderTransitionSource {
  return role === 'ADMIN' ? 'ADMIN_APP' : 'APP';
}

/**
 * Preuve de remise d'une commande (F3-07). Écrite avec `LIVRER`, dans le même
 * `updateMany` que le statut, par `OrderTransitionService` — le seul endroit.
 *
 * TEXT en base, borné ici et par le CHECK `Order_deliveryProof_valid` : les
 * deux listes doivent rester identiques (`order-transition.spec.ts` le
 * vérifie). Même raison que les acteurs : pas d'enum PostgreSQL.
 *
 * `LIVRER` seul ne prouve rien : une livraison sans code, ou un retrait que le
 * vendeur déclare seul, n'attestent pas que le client a reçu son repas. C'est
 * cette colonne, et non le statut, qui dit si le vendeur peut être payé sans
 * geste humain.
 */
export const DELIVERY_PROOFS = [
  /** Le livreur a saisi le code montré au client (F-06). */
  'DELIVERY_CODE',
  /** Un administrateur a clôturé la course (arbitrage, audité). */
  'DELIVERY_ADMIN_OVERRIDE',
  /** Course conclue sans code (code non exigé, ou course antérieure). */
  'DELIVERY_UNVERIFIED',
  /** Retrait : le vendeur a saisi le code montré par le client (D-P5). */
  'PICKUP_CODE',
  /** Retrait : le client a appuyé « J'ai récupéré ma commande ». */
  'PICKUP_CUSTOMER_CONFIRMED',
  /** Retrait : un administrateur a clôturé la commande. */
  'PICKUP_ADMIN_OVERRIDE',
  /** Retrait : le vendeur seul a déclaré la remise. Aucun versement. */
  'PICKUP_VENDOR_DECLARED',
] as const;

export type DeliveryProof = (typeof DELIVERY_PROOFS)[number];

/**
 * Preuves qui ouvrent le versement automatique au vendeur (I-6, I-7). Miroir
 * du CHECK `Order_payoutDueAt_needs_proof`.
 */
export const AUTO_PAYOUT_PROOFS: readonly DeliveryProof[] = [
  'DELIVERY_CODE',
  'DELIVERY_ADMIN_OVERRIDE',
  'PICKUP_CODE',
  'PICKUP_CUSTOMER_CONFIRMED',
  'PICKUP_ADMIN_OVERRIDE',
];

/** Délai par défaut entre la preuve et le versement (D5), sans ligne de réglages. */
export const DEFAULT_VENDOR_PAYOUT_DELAY_MINUTES = 60;

/**
 * Échéance du versement automatique, ou `null` si la preuve n'y ouvre pas droit.
 *
 * C'est le **seul** endroit où livraison et retrait se distinguent pour
 * l'argent — et encore : par la preuve, pas par le mode. Le worker de
 * versement lit `payoutDueAt` et n'a pas à savoir qui a cliqué.
 */
export function payoutDueAtFor(
  proof: DeliveryProof,
  provedAt: Date,
  delayMinutes: number,
): Date | null {
  if (!AUTO_PAYOUT_PROOFS.includes(proof)) return null;
  return new Date(provedAt.getTime() + delayMinutes * 60_000);
}
