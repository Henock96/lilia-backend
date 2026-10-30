/**
 * Règles du rapprochement quotidien Lilia ↔ prestataire (lot 2, 30/10/2026).
 *
 * Fonctions PURES : elles comparent ce que dit le prestataire (export
 * normalisé) à ce que dit Lilia (instantané lu en base) et rendent la liste
 * des écarts. Rien n'est corrigé : un écart s'explique ou se résout par un
 * humain, avec motif (`ReconciliationService.resolve`).
 *
 * ⚠️ FORMAT D'ENTRÉE. Le format exact de l'export du tableau de bord pawaPay
 * n'a pas pu être vérifié depuis le dépôt (30/10/2026). L'import attend donc
 * une ligne NORMALISÉE par transaction (`ProviderRow`) ; la correspondance
 * avec les colonnes réelles de l'export est à écrire une fois l'export en main.
 */

export const RECONCILIATION_TYPES = [
  'PROVIDER_ONLY',
  'LILIA_ONLY',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'STATUS_CONFLICT',
  'DUPLICATE_PROVIDER_ROW',
  'FEE_UNKNOWN',
  'FEE_MISMATCH',
  'REFUND_WITHOUT_PROOF',
  'STALE_IN_FLIGHT',
  'CLEARING_RESIDUAL',
  'WALLET_BALANCE_MISMATCH',
] as const;
export type ReconciliationType = (typeof RECONCILIATION_TYPES)[number];

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM';

/**
 * Portée du blocage des versements :
 *  · `VENDOR` — bloque les versements du vendeur concerné seulement ;
 *  · `GLOBAL` — bloque tous les versements (risque sur le wallet) ;
 *  · `NONE`   — à traiter, mais n'arrête pas les versements.
 */
export type BlockScope = 'VENDOR' | 'GLOBAL' | 'NONE';

/** Gravité, portée et procédure par type — une seule table, décidée ici. */
export const RULES: Record<
  ReconciliationType,
  { severity: Severity; block: BlockScope; label: string; procedure: string }
> = {
  PROVIDER_ONLY: {
    severity: 'CRITICAL',
    block: 'GLOBAL',
    label: 'Transaction chez le prestataire, absente de Lilia',
    procedure:
      'Retrouver la transaction dans le tableau de bord (identifiant, numéro, date). Encaissement : rattacher au client ou rembourser. Sortie d’argent : établir qui l’a ordonnée avant tout nouveau versement.',
  },
  LILIA_ONLY: {
    severity: 'CRITICAL',
    block: 'VENDOR',
    label: 'Opération conclue chez Lilia, absente de l’export prestataire',
    procedure:
      'Vérifier la période de l’export, puis interroger le prestataire sur l’identifiant. S’il ne la connaît pas, l’opération n’a pas eu lieu : ouvrir un incident.',
  },
  AMOUNT_MISMATCH: {
    severity: 'CRITICAL',
    block: 'VENDOR',
    label: 'Montant différent',
    procedure:
      'Comparer le montant demandé et le montant confirmé ; aucun versement de ce vendeur tant que l’écart n’est pas expliqué.',
  },
  CURRENCY_MISMATCH: {
    severity: 'CRITICAL',
    block: 'VENDOR',
    label: 'Devise différente de XAF',
    procedure: 'Vérifier la configuration du compte prestataire (devise).',
  },
  STATUS_CONFLICT: {
    severity: 'CRITICAL',
    block: 'VENDOR',
    label: 'Statut contradictoire',
    procedure:
      'Le prestataire fait foi sur le mouvement d’argent : réconcilier la transaction (« Réconcilier »), puis traiter l’incident ouvert.',
  },
  DUPLICATE_PROVIDER_ROW: {
    severity: 'CRITICAL',
    block: 'GLOBAL',
    label: 'Identifiant présent deux fois dans l’export',
    procedure:
      'Vérifier l’export (doublon de fichier) ou un double débit chez le prestataire.',
  },
  FEE_UNKNOWN: {
    severity: 'MEDIUM',
    block: 'NONE',
    label: 'Frais prestataire non connus de Lilia',
    procedure:
      'Enregistrer les frais confirmés par l’export (import autorisé) ; sinon la marge de la commande reste « inconnue ».',
  },
  FEE_MISMATCH: {
    severity: 'MEDIUM',
    block: 'NONE',
    label: 'Frais différents',
    procedure:
      'Comparer à la grille du contrat ; corriger par une écriture justifiée, jamais en écrasant.',
  },
  REFUND_WITHOUT_PROOF: {
    severity: 'HIGH',
    block: 'NONE',
    label: 'Remboursement « terminé » sans preuve',
    procedure:
      'Retrouver la référence du remboursement (relevé Mobile Money, reçu) et la consigner ; à défaut, l’expliquer.',
  },
  STALE_IN_FLIGHT: {
    severity: 'HIGH',
    block: 'VENDOR',
    label: 'Opération en cours depuis plus de 24 h',
    procedure:
      'Ne rien relancer : interroger le prestataire sur l’identifiant ; s’il ne la connaît pas, la clore en échec.',
  },
  CLEARING_RESIDUAL: {
    severity: 'HIGH',
    block: 'NONE',
    label: 'Argent en transit sur une commande close',
    procedure:
      'Commande annulée encaissée sans remboursement, ou livrée sans encaissement : rembourser, rattacher, ou expliquer.',
  },
  WALLET_BALANCE_MISMATCH: {
    severity: 'CRITICAL',
    block: 'GLOBAL',
    label: 'Solde du wallet différent du grand livre',
    procedure:
      'Aucun versement tant que l’écart n’est pas expliqué ligne à ligne (opérations hors Lilia, frais, transactions orphelines).',
  },
};

/** Ligne normalisée de l'export prestataire. */
export interface ProviderRow {
  /** `depositId` (encaissement) ou `payoutId` (versement, remboursement). */
  externalId: string;
  kind: 'DEPOSIT' | 'PAYOUT';
  /** Statut prestataire brut : `COMPLETED`, `FAILED`, `ACCEPTED`… */
  status: string;
  amountXaf: number;
  currency: string;
  /** Frais facturés, quand l'export les donne. `null` = non fourni. */
  feeXaf?: number | null;
}

/** Ce que Lilia sait d'une opération rattachée à un identifiant prestataire. */
export interface LiliaOperation {
  externalId: string;
  kind: 'DEPOSIT' | 'PAYOUT';
  entity: 'Payment' | 'RestaurantPayout' | 'Refund';
  entityId: string;
  /** `SUCCESS`/`FAILED`… (paiements, versements), `COMPLETED`… (remboursements). */
  status: string;
  amountXaf: number;
  currency: string;
  feeXaf: number | null;
  restaurantId: string | null;
  orderId: string | null;
  /** Conclue (au sens Lilia) dans la période de l'export ? */
  concludedInPeriod: boolean;
}

export interface Finding {
  itemKey: string;
  type: ReconciliationType;
  severity: Severity;
  restaurantId?: string | null;
  orderId?: string | null;
  paymentId?: string | null;
  payoutId?: string | null;
  refundId?: string | null;
  externalId?: string | null;
  expectedXaf?: number | null;
  actualXaf?: number | null;
  detail: string;
}

const SUCCESS_PROVIDER = new Set(['COMPLETED']);
const FAILED_PROVIDER = new Set(['FAILED', 'REJECTED', 'CANCELLED']);
const SUCCESS_LILIA = new Set(['SUCCESS', 'COMPLETED']);
const FAILED_LILIA = new Set(['FAILED', 'CANCELLED', 'REJECTED']);

function refs(op: LiliaOperation) {
  return {
    restaurantId: op.restaurantId,
    orderId: op.orderId,
    ...(op.entity === 'Payment' ? { paymentId: op.entityId } : {}),
    ...(op.entity === 'RestaurantPayout' ? { payoutId: op.entityId } : {}),
    ...(op.entity === 'Refund' ? { refundId: op.entityId } : {}),
  };
}

export function finding(
  type: ReconciliationType,
  key: string,
  fields: Omit<Finding, 'itemKey' | 'type' | 'severity'>,
): Finding {
  return {
    itemKey: `${type}:${key}`,
    type,
    severity: RULES[type].severity,
    ...fields,
  };
}

/** Compare l'export prestataire aux opérations Lilia. */
export function compareProviderRows(
  rows: ProviderRow[],
  lilia: LiliaOperation[],
): Finding[] {
  const out: Finding[] = [];
  const byId = new Map<string, LiliaOperation>();
  for (const op of lilia) byId.set(`${op.kind}:${op.externalId}`, op);

  const seen = new Map<string, number>();
  for (const row of rows) {
    const k = `${row.kind}:${row.externalId}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) {
    if (n > 1) {
      out.push(
        finding('DUPLICATE_PROVIDER_ROW', k, {
          externalId: k.split(':').slice(1).join(':'),
          detail: `${n} lignes pour le même identifiant dans l'export`,
        }),
      );
    }
  }

  const matched = new Set<string>();
  for (const row of rows) {
    const k = `${row.kind}:${row.externalId}`;
    const op = byId.get(k);
    if (!op) {
      // Une tentative échouée inconnue de Lilia ne déplace pas d'argent.
      if (SUCCESS_PROVIDER.has(row.status)) {
        out.push(
          finding('PROVIDER_ONLY', k, {
            externalId: row.externalId,
            actualXaf: row.amountXaf,
            detail: `${row.kind === 'DEPOSIT' ? 'Encaissement' : 'Sortie'} de ${row.amountXaf} ${row.currency} au statut ${row.status}, inconnu de Lilia`,
          }),
        );
      }
      continue;
    }
    matched.add(k);
    if (row.currency !== 'XAF' || op.currency !== 'XAF') {
      out.push(
        finding('CURRENCY_MISMATCH', k, {
          ...refs(op),
          externalId: row.externalId,
          detail: `Devise prestataire ${row.currency}, Lilia ${op.currency}`,
        }),
      );
    }
    const providerOk = SUCCESS_PROVIDER.has(row.status);
    const providerKo = FAILED_PROVIDER.has(row.status);
    const liliaOk = SUCCESS_LILIA.has(op.status);
    const liliaKo = FAILED_LILIA.has(op.status);
    if ((providerOk && liliaKo) || (providerKo && liliaOk)) {
      out.push(
        finding('STATUS_CONFLICT', k, {
          ...refs(op),
          externalId: row.externalId,
          detail: `Prestataire ${row.status}, Lilia ${op.status}`,
        }),
      );
    }
    if (providerOk && row.amountXaf !== op.amountXaf) {
      out.push(
        finding('AMOUNT_MISMATCH', k, {
          ...refs(op),
          externalId: row.externalId,
          expectedXaf: op.amountXaf,
          actualXaf: row.amountXaf,
          detail: `Lilia ${op.amountXaf} XAF, prestataire ${row.amountXaf} XAF`,
        }),
      );
    }
    if (providerOk && row.feeXaf != null) {
      if (op.feeXaf == null) {
        out.push(
          finding('FEE_UNKNOWN', k, {
            ...refs(op),
            externalId: row.externalId,
            actualXaf: row.feeXaf,
            detail: `Frais annoncés par le prestataire : ${row.feeXaf} XAF`,
          }),
        );
      } else if (op.feeXaf !== row.feeXaf) {
        out.push(
          finding('FEE_MISMATCH', k, {
            ...refs(op),
            externalId: row.externalId,
            expectedXaf: op.feeXaf,
            actualXaf: row.feeXaf,
            detail: `Frais Lilia ${op.feeXaf} XAF, prestataire ${row.feeXaf} XAF`,
          }),
        );
      }
    }
  }

  // Conclu chez Lilia, dans la période, et absent de l'export.
  for (const op of lilia) {
    const k = `${op.kind}:${op.externalId}`;
    if (
      matched.has(k) ||
      !op.concludedInPeriod ||
      !SUCCESS_LILIA.has(op.status)
    ) {
      continue;
    }
    out.push(
      finding('LILIA_ONLY', k, {
        ...refs(op),
        externalId: op.externalId,
        expectedXaf: op.amountXaf,
        detail: `${op.entity} ${op.status} de ${op.amountXaf} XAF absent de l'export`,
      }),
    );
  }
  return out;
}

/** Solde du wallet déclaré contre le solde `psp:PAWAPAY` du grand livre. */
export function compareWalletBalance(
  walletBalanceXaf: number | null | undefined,
  ledgerPspBalanceXaf: number,
): Finding[] {
  if (walletBalanceXaf == null || walletBalanceXaf === ledgerPspBalanceXaf) {
    return [];
  }
  return [
    finding('WALLET_BALANCE_MISMATCH', 'psp:PAWAPAY', {
      expectedXaf: ledgerPspBalanceXaf,
      actualXaf: walletBalanceXaf,
      detail: `Wallet ${walletBalanceXaf} XAF, grand livre ${ledgerPspBalanceXaf} XAF (écart ${walletBalanceXaf - ledgerPspBalanceXaf})`,
    }),
  ];
}

/** Portée du blocage d'un type d'écart. */
export function blockScopeOf(type: string): BlockScope {
  return (
    (RULES as Record<string, { block: BlockScope }>)[type]?.block ?? 'NONE'
  );
}
