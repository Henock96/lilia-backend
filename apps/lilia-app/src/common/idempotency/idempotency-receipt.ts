import { Prisma } from '@prisma/client';

/**
 * Reçus d'idempotence (durcissement lot 4) — table `IdempotencyReceipt`.
 *
 * Pour un geste rejouable qui n'a pas de ligne métier propre où poser sa clé.
 * Le reçu s'écrit **dans** la transaction du geste : deux requêtes portant la
 * même clé se sérialisent sur la clé primaire, la seconde échoue en `P2002`
 * après le commit de la première, et relit alors le reçu.
 *
 * Miroir du CHECK `IdempotencyReceipt_scope_known`
 * (migration `20261030140000_postgres_idempotency_and_cron_lease`).
 */
export const IDEMPOTENCY_SCOPES = ['stock.restock'] as const;
export type IdempotencyScope = (typeof IDEMPOTENCY_SCOPES)[number];

export interface IdempotencyReceiptInput {
  scope: IdempotencyScope;
  /** Appelant qui a posé la clé (`User.id`). */
  ownerId: string;
  key: string;
  /** Décrit le geste : une même clé pour un autre geste est un conflit. */
  fingerprint: string;
}

/** Ce qu'un reçu déjà écrit dit du geste présenté. */
export type PriorReceipt = 'replay' | 'conflict' | null;

export async function findPriorReceipt(
  db: Pick<Prisma.TransactionClient, 'idempotencyReceipt'>,
  receipt: IdempotencyReceiptInput,
): Promise<PriorReceipt> {
  const prior = await db.idempotencyReceipt.findUnique({
    where: {
      scope_ownerId_key: {
        scope: receipt.scope,
        ownerId: receipt.ownerId,
        key: receipt.key,
      },
    },
    select: { fingerprint: true },
  });
  if (!prior) return null;
  return prior.fingerprint === receipt.fingerprint ? 'replay' : 'conflict';
}

/** Une transaction concurrente a écrit le même reçu avant celle-ci. */
export function isReceiptCollision(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
