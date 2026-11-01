/**
 * Parcours d'une commande (durcissement lot 3, 30/10/2026).
 *
 *  - `PAY_FIRST`    — historique : payer, puis le vendeur accepte.
 *  - `ACCEPT_FIRST` — le vendeur accepte la demande (`DEMANDE_ENVOYEE`), puis
 *                     le client paie (`EN_ATTENTE`) ; payée, elle est déjà
 *                     acceptée (`PAYER`, `acceptedAt` posé).
 *
 * Ce n'est pas une seconde machine d'états : la matrice reste
 * `order-state.machine.ts`, qui porte un état de plus. Le parcours ne dit que
 * l'ordre dans lequel le client et le vendeur s'engagent ; il est figé sur la
 * commande au checkout.
 *
 * Liste miroir du CHECK `Order_orderFlow_known` (règle 14).
 */
export const ORDER_FLOWS = ['PAY_FIRST', 'ACCEPT_FIRST'] as const;
export type OrderFlow = (typeof ORDER_FLOWS)[number];

export function isOrderFlow(value: unknown): value is OrderFlow {
  return (ORDER_FLOWS as readonly unknown[]).includes(value);
}

/**
 * Capacité déclarée par une application qui sait conduire le nouveau
 * parcours — client (attendre l'acceptation, puis payer) comme vendeur
 * (répondre à une demande). Même principe que `X-Lilia-Payment-Flow` : une
 * capacité, pas un numéro de version. Une application qui n'annonce rien
 * n'est jamais engagée dans le nouveau parcours.
 */
export const ORDER_FLOW_HEADER = 'x-lilia-order-flow';
export const ACCEPT_FIRST_CAPABILITY = 'accept-first';

export function declaresAcceptFirst(
  raw: string | string[] | undefined,
): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (
    typeof value === 'string' &&
    value
      .split(',')
      .some((part) => part.trim().toLowerCase() === ACCEPT_FIRST_CAPABILITY)
  );
}

/**
 * Parcours d'une commande au checkout.
 *
 * `ACCEPT_FIRST` seulement si TOUT est réuni :
 *  - le réglage plateforme l'active ;
 *  - l'application du client l'annonce ;
 *  - ce n'est pas une précommande (sa réponse vendeur suit d'autres délais,
 *    `preorderAcceptanceHours` : reportée) ;
 *  - il y a quelque chose à payer (une commande réglée en points n'a pas de
 *    fenêtre de paiement).
 * Sinon `PAY_FIRST`, comme aujourd'hui.
 */
export function chooseOrderFlow(input: {
  platformFlow: string | null | undefined;
  clientDeclaresAcceptFirst: boolean;
  isPreorder: boolean;
  totalXaf: number;
}): OrderFlow {
  if (input.platformFlow !== 'ACCEPT_FIRST') return 'PAY_FIRST';
  if (!input.clientDeclaresAcceptFirst) return 'PAY_FIRST';
  if (input.isPreorder) return 'PAY_FIRST';
  if (input.totalXaf <= 0) return 'PAY_FIRST';
  return 'ACCEPT_FIRST';
}

const MINUTE_MS = 60_000;

/** Échéance de réponse du vendeur à une demande. */
export function requestExpiry(now: Date, timeoutMinutes: number): Date {
  return new Date(now.getTime() + timeoutMinutes * MINUTE_MS);
}

/** Échéance de paiement d'une demande acceptée. */
export function paymentDeadline(acceptedAt: Date, windowMinutes: number): Date {
  return new Date(acceptedAt.getTime() + windowMinutes * MINUTE_MS);
}
