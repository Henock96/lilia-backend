/**
 * Vocabulaire du grand livre (lot 2 du durcissement, 30/10/2026).
 *
 * `TEXT` + CHECK en base, listes miroir ici (règle 14 de la constitution : pas
 * d'enum PostgreSQL pour un vocabulaire appelé à évoluer). Le test
 * `ledger.int-spec.ts` vérifie que la base refuse une valeur absente de ces
 * listes.
 *
 * ## Convention de signe
 *
 * Une écriture est un montant entier XAF **signé** : débit positif, crédit
 * négatif. Une transaction est équilibrée quand la somme de ses lignes vaut 0
 * (contrainte vérifiée par un trigger différé).
 *
 * ## Les comptes
 *
 * | Compte | Nature | Solde positif = |
 * |---|---|---|
 * | `psp:<PRESTATAIRE>` | actif | argent détenu chez le prestataire (pawaPay…) |
 * | `cash:manual` | actif | argent entré ou sorti hors prestataire, déclaré avec référence |
 * | `suspense:unmatched` | attente | mouvement dont la contrepartie n'est pas prouvée |
 * | `clearing:order` | transitoire, par commande | encaissé, pas encore acquis |
 * | `vendor_payable` | passif, par vendeur | (négatif) dû au vendeur |
 * | `driver_payable` | passif, par livreur | (négatif) dû au livreur |
 * | `revenue:*` | produit | (négatif) revenu de Lilia Food |
 * | `expense:*` | charge | coût supporté par Lilia Food |
 *
 * Les opérations **en vol** (encaissement, versement ou remboursement envoyé,
 * issue inconnue) ne sont PAS écrites : seul un fait conclu l'est. Elles
 * restent visibles dans le rapprochement et le cockpit (`*_in_flight`).
 */
export const LEDGER_ACCOUNTS = [
  'cash:manual',
  'suspense:unmatched',
  'clearing:order',
  'vendor_payable',
  'driver_payable',
  'revenue:service_fee',
  'revenue:commission',
  'revenue:delivery',
  'expense:platform_discount',
  'expense:refund_platform',
  'expense:driver_cost',
  'expense:psp_fee',
  'expense:vendor_adjustment',
] as const;

/** Compte d'un prestataire : `psp:PAWAPAY`, `psp:MANUAL`, `psp:MTN_MOMO`. */
export type PspAccount = `psp:${string}`;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number] | PspAccount;

/** Motif SQL miroir (CHECK `LedgerEntry_account_known`). */
export const LEDGER_ACCOUNT_PATTERN =
  '^(psp:[A-Z_]+|cash:manual|suspense:unmatched|clearing:order|vendor_payable|driver_payable|revenue:(service_fee|commission|delivery)|expense:(platform_discount|refund_platform|driver_cost|psp_fee|vendor_adjustment))$';

export function pspAccount(provider: string): PspAccount {
  const p = provider.trim().toUpperCase();
  if (!/^[A-Z_]+$/.test(p)) {
    throw new Error(`Prestataire de paiement illisible : « ${provider} »`);
  }
  return `psp:${p}`;
}

/** Sous-compte : à qui la ligne se rapporte. */
export const LEDGER_SUBJECT_TYPES = ['ORDER', 'VENDOR', 'DRIVER'] as const;
export type LedgerSubjectType = (typeof LEDGER_SUBJECT_TYPES)[number];

/** Nature du mouvement. */
export const LEDGER_KINDS = [
  'COLLECTION', // encaissement confirmé
  'ACQUISITION', // commande livrée : l'argent encaissé se répartit
  'DRIVER_COST', // course livrée : dû au livreur
  'REFUND', // remboursement effectué
  'PAYOUT', // versement vendeur abouti
  'PSP_FEE', // frais prestataire CONFIRMÉS
  'DRIVER_SETTLEMENT', // règlement livreur
  'VENDOR_ADJUSTMENT', // correction manuelle motivée du solde vendeur
  'REVERSAL', // contre-passation d'une transaction
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/**
 * D'où vient la preuve du fait comptabilisé. Ce n'est PAS le mode d'écriture
 * (direct ou reprise), porté à part par `postingMode`.
 */
export const LEDGER_ORIGINS = [
  'WEBHOOK',
  'RECONCILIATION',
  'CLIENT_POLL',
  'INITIATION',
  'ADMIN',
  'SYSTEM',
  'UNKNOWN',
] as const;
export type LedgerOrigin = (typeof LEDGER_ORIGINS)[number];

export const LEDGER_POSTING_MODES = ['LIVE', 'BACKFILL'] as const;
export type LedgerPostingMode = (typeof LEDGER_POSTING_MODES)[number];
