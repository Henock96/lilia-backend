import { ProviderTransactionStatus } from '../payment-provider.interface';
import {
  PawaPayDepositStatus,
  PawaPayPayoutStatus,
  PawaPayTransaction,
} from './pawapay.types';

/**
 * Traductions entre le vocabulaire pawaPay et celui du domaine.
 *
 * Fonctions pures, sans dépendance Nest : c'est la partie du provider qu'on
 * veut pouvoir tester sans monter de module ni simuler de réseau.
 */

/**
 * Statuts **terminaux** de pawaPay. Tout le reste (`ACCEPTED`, `ENQUEUED`,
 * `PROCESSING`, `IN_RECONCILIATION`) signifie « pas encore décidé » et ne doit
 * déclencher aucune transition métier.
 *
 * `IN_RECONCILIATION` mérite une mention : pawaPay le documente comme « en cours
 * de rapprochement avec l'opérateur ». C'est explicitement **non terminal** —
 * le traiter comme un échec annulerait des paiements qui aboutissent.
 */
const TERMINAL_SUCCESS = 'COMPLETED';
const TERMINAL_FAILURE = 'FAILED';

export function mapPawaPayState(
  rawStatus: PawaPayDepositStatus | PawaPayPayoutStatus | string,
): 'PENDING' | 'SUCCESS' | 'FAILED' {
  if (rawStatus === TERMINAL_SUCCESS) return 'SUCCESS';
  if (rawStatus === TERMINAL_FAILURE) return 'FAILED';
  return 'PENDING';
}

/**
 * Montant pawaPay (chaîne) → entier XAF.
 *
 * Le XAF n'a pas de sous-unité (`decimalsInAmount: NONE` dans la configuration
 * active), mais la valeur arrive en chaîne et pourrait porter une partie
 * décimale sur une autre devise. On arrondit plutôt que de tronquer, et on rend
 * `undefined` sur une valeur inexploitable : un contrôle de montant impossible
 * doit être signalé comme tel, jamais silencieusement réussi.
 */
export function parseAmountToXaf(amount?: string): number | undefined {
  if (amount === undefined || amount === null || amount === '')
    return undefined;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed);
}

/**
 * Entier XAF → chaîne attendue par pawaPay.
 *
 * Motif imposé : `^([0]|([1-9][0-9]{0,17}))([.][0-9]{0,3}[1-9])?$`. Un montant
 * non entier ou négatif n'a pas de représentation valide — on lève plutôt que
 * d'envoyer une chaîne que pawaPay rejetterait avec un `INVALID_AMOUNT` opaque.
 */
export function formatAmountForPawaPay(amountXaf: number): string {
  if (!Number.isFinite(amountXaf) || !Number.isInteger(amountXaf)) {
    throw new Error(
      `Montant non entier transmis au prestataire : ${amountXaf}. ` +
        'Les montants XAF doivent être des entiers.',
    );
  }
  if (amountXaf <= 0) {
    throw new Error(
      `Montant nul ou négatif transmis au prestataire : ${amountXaf}.`,
    );
  }
  return String(amountXaf);
}

/**
 * Message affiché au client dans son SMS de reçu.
 *
 * Contraintes pawaPay : 4 à 22 caractères, `^[a-zA-Z0-9 ]+$`. Ni accents, ni
 * tiret, ni `#`. Une chaîne non conforme fait rejeter toute la transaction —
 * on nettoie donc plutôt que d'espérer.
 */
export function sanitizeCustomerMessage(
  raw: string,
  fallback = 'Lilia Food',
): string {
  const cleaned = raw
    .normalize('NFD')
    // Retire les diacritiques : « Chez Mère Lili » → « Chez Mere Lili ».
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 22)
    .trim();

  return cleaned.length >= 4 ? cleaned : fallback;
}

/**
 * MSISDN attendu par pawaPay : chiffres uniquement, indicatif pays inclus,
 * sans `+` ni préfixe international.
 *
 * ⚠️ **Le zéro initial est CONSERVÉ.** Les mobiles congolais s'écrivent
 * `06 XXX XX XX` / `05 …` / `04 …` — neuf chiffres dont le premier fait partie
 * du numéro, et non un préfixe interurbain à retirer. En international :
 * `242 06 XXX XX XX`, soit douze chiffres.
 *
 * C'est déjà la convention du backend (`formatMtnPhoneNumber` préfixe `242`
 * sans rien retirer) et celle sous laquelle les paiements manuels ont
 * fonctionné en production.
 *
 * 🔶 **Divergence connue** : `lilia-app/lib/features/payments/data/payment_service.dart`
 * retirait ce zéro (`242 61234567`, onze chiffres). Le client a été aligné, et
 * `normalize` ci-dessous **réinsère** le zéro sur les onze chiffres pour rester
 * compatible avec les versions déjà installées sur les téléphones — une
 * application non mise à jour ne doit pas envoyer d'argent vers un numéro
 * inexistant.
 *
 * 🔴 **À CONFIRMER en sandbox avant la mise en production** : un dépôt réel sur
 * un numéro connu lève tout doute. Se tromper de forme ne provoque pas d'erreur
 * visible — la demande part vers un numéro qui n'existe pas, ou pire, qui
 * appartient à quelqu'un d'autre.
 */
export function toMsisdn(phone: string, countryCode = '242'): string {
  let digits = phone.replace(/\D/g, '');

  // Préfixe international composé (00242…) → on ne garde que l'indicatif pays.
  if (digits.startsWith('00' + countryCode)) {
    digits = digits.slice(2);
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (!digits.startsWith(countryCode)) {
    digits = countryCode + digits;
  }

  const national = digits.slice(countryCode.length);

  // Forme « historique » à huit chiffres (zéro initial retiré par une ancienne
  // version du client) : on le réinsère plutôt que de laisser passer un numéro
  // incomplet.
  if (/^[456]\d{7}$/.test(national)) {
    return countryCode + '0' + national;
  }

  return digits;
}

/**
 * Le MSISDN est-il un mobile congolais plausible ?
 *
 * `242` + `0` + opérateur (`4`, `5` ou `6`) + sept chiffres.
 */
export function isValidCongoMsisdn(msisdn: string): boolean {
  return /^2420[456]\d{7}$/.test(msisdn);
}

/**
 * Transaction pawaPay → statut normalisé.
 *
 * `requestedAmount` est privilégié sur `amount` pour le contrôle anti-mismatch :
 * c'est le montant que **nous** avons demandé, celui qu'on peut comparer à ce
 * qu'on a enregistré. `amount` est ce qui a été mouvementé et peut, sur certains
 * opérateurs, différer légèrement.
 */
export function toProviderStatus(
  tx: PawaPayTransaction,
): ProviderTransactionStatus {
  return {
    state: mapPawaPayState(tx.status),
    rawStatus: tx.status,
    amountXaf:
      parseAmountToXaf(tx.requestedAmount) ?? parseAmountToXaf(tx.amount),
    currency: tx.currency,
    providerTransactionId: tx.providerTransactionId,
    failureCode: tx.failureReason?.failureCode,
    failureMessage: tx.failureReason?.failureMessage,
    raw: tx,
  };
}

/**
 * Numéro du compte, quelle que soit la graphie.
 *
 * La documentation pawaPay écrit `phoneNUmber` (N majuscule) dans ses exemples
 * de réponse et `phoneNumber` dans ses schémas. On accepte les deux : ni leur
 * correction, ni son absence, ne doit casser la lecture d'un callback qui porte
 * de l'argent.
 */
export function readPhoneNumber(details?: {
  phoneNumber?: string;
  phoneNUmber?: string;
}): string | undefined {
  return details?.phoneNumber ?? details?.phoneNUmber;
}
