import { ReferralRewardStatus } from '@prisma/client';

/**
 * Poids et seuils du scoring anti-abus du parrainage.
 *
 * ## Pourquoi un fichier séparé
 *
 * Ces nombres sont les seuls endroits où « ce comportement est suspect » est
 * quantifié. Dispersés dans le service, ils auraient été impossibles à relire
 * d'un coup d'œil et à ajuster sans se demander ce qu'on casse ailleurs. Ici,
 * une revue tient en un écran — et c'est la condition posée au §28 du cahier
 * des charges : *compréhensible par un développeur qui reprend le projet dans
 * six mois*.
 *
 * ## Le principe
 *
 * On n'interdit pas un comportement, on **arbitre une récompense**. La commande
 * du filleul reste valide, livrée et facturée dans tous les cas ; seul le point
 * versé au parrain dépend de ce score. C'est ce qui permet d'être strict sans
 * jamais pénaliser un client réel.
 *
 * ## Ce qu'on ne fait surtout pas
 *
 * Refuser sur le seul partage d'appareil. Un téléphone se prête, une famille
 * commande depuis la même tablette, une réinstallation change l'identifiant :
 * `DEVICE_SHARED` seul (25) reste sous le seuil de revue. Il faut un second
 * signal — un numéro réutilisé, ou un filleul déjà converti depuis cette
 * installation pour le même parrain — pour qu'une récompense soit retenue.
 */

/** Signaux évalués. Le nom est celui qui apparaît dans les logs et en base. */
export type ReferralRiskSignalCode =
  | 'DEVICE_SHARED'
  | 'PHONE_REUSED'
  | 'NO_PHONE'
  | 'DEVICE_ACCOUNT_FARM'
  | 'DEVICE_SAME_REFERRER'
  | 'REFERRER_VELOCITY'
  | 'DEVICE_BLOCKED';

export interface ReferralRiskSignal {
  code: ReferralRiskSignalCode;
  /** Points de risque ajoutés (0–100). */
  weight: number;
  /** Phrase lisible par un humain — c'est elle qui sera relue en revue. */
  detail: string;
}

export const REFERRAL_RISK_WEIGHTS = {
  /**
   * Un autre compte s'est déjà synchronisé depuis cette installation.
   * Compté **par compte supplémentaire**, plafonné : deux comptes sur un
   * téléphone, c'est un couple ; huit, c'est une ferme.
   */
  DEVICE_SHARED_PER_ACCOUNT: 25,
  DEVICE_SHARED_MAX: 50,

  /**
   * Le numéro de téléphone du filleul est déjà porté par un autre compte.
   *
   * Poids le plus élevé des signaux simples, et **délibérément calibré pour
   * atteindre à lui seul le seuil de revue** : au Congo, obtenir une seconde
   * ligne coûte quelque chose, alors que réinstaller une application est
   * gratuit. Un même numéro sur deux comptes est donc bien plus parlant qu'un
   * même appareil.
   */
  PHONE_REUSED: 65,

  /** Aucun téléphone : identité faible, mais pas disqualifiante à elle seule. */
  NO_PHONE: 15,

  /** L'installation a donné naissance à au moins `DEVICE_ACCOUNT_FARM_THRESHOLD` comptes. */
  DEVICE_ACCOUNT_FARM: 20,

  /**
   * L'installation a **déjà** converti un filleul pour le **même parrain**.
   * C'est la signature exacte du scénario décrit au §9 du cahier des charges :
   * un appareil, un code, des comptes jetables en série.
   */
  DEVICE_SAME_REFERRER: 40,

  /** Le parrain a déjà encaissé plusieurs récompenses dans les dernières 24 h. */
  REFERRER_VELOCITY: 20,

  /** Installation marquée `BLOCKED` par un administrateur : refus direct. */
  DEVICE_BLOCKED: 100,
} as const;

/** À partir de combien de comptes une installation devient une « ferme ». */
export const DEVICE_ACCOUNT_FARM_THRESHOLD = 3;

/** À partir de combien de récompenses en 24 h un parrain devient « rapide ». */
export const REFERRER_VELOCITY_THRESHOLD = 3;
export const REFERRER_VELOCITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Bandes de décision.
 *
 * ```
 *   0 – 30  APPROVED        normal
 *  31 – 60  APPROVED        crédité, mais journalisé pour analyse
 *  61 – 80  PENDING_REVIEW  rien versé, file d'attente admin
 *  81 – 100 REJECTED        rien versé, motif conservé
 * ```
 *
 * La bande 31–60 crédite **volontairement**. Un signal isolé n'est pas une
 * fraude, et faire attendre un parrain légitime pour un appareil partagé
 * abîmerait le programme plus sûrement que le fraudeur qu'on cherche.
 */
export const REFERRAL_RISK_THRESHOLDS = {
  /** Au-delà : on journalise `REFERRAL_RISK_DETECTED` sans rien changer. */
  WATCH: 31,
  /** Au-delà : revue humaine obligatoire avant tout crédit. */
  REVIEW: 61,
  /** Au-delà : refus. */
  REJECT: 81,
} as const;

/** Traduit un score en décision. Seule fonction autorisée à le faire. */
export function decideFromScore(score: number): ReferralRewardStatus {
  if (score >= REFERRAL_RISK_THRESHOLDS.REJECT) {
    return ReferralRewardStatus.REJECTED;
  }
  if (score >= REFERRAL_RISK_THRESHOLDS.REVIEW) {
    return ReferralRewardStatus.PENDING_REVIEW;
  }
  return ReferralRewardStatus.APPROVED;
}
