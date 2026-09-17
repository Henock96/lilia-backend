import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { MAX_COMMISSION_PERCENT } from '../../payments/money.util';

/**
 * Version d'application acceptée : `major.minor.patch`, `+build` optionnel.
 *
 * Volontairement **plus strict** que le parseur des applications mobiles
 * (`AppVersion.tryParse`, qui tolère en plus un « v » initial et des espaces).
 * L'asymétrie est le bon sens : on est exigeant sur ce qu'on **enregistre**,
 * tolérant sur ce qu'on **reçoit**.
 *
 * Ce qui ne doit jamais s'inverser, c'est la direction : le serveur ne doit
 * pas accepter une forme que les clients rejetteraient. L'administrateur
 * croirait avoir posé un seuil qui n'existe nulle part — une panne silencieuse
 * dans le sens le plus dangereux, celui où l'on se croit protégé.
 */
export const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(\+\d+)?$/;

/**
 * Bornes du barème plateforme.
 *
 * Elles existent parce que ces champs n'avaient qu'un `@Min(0)` : un
 * `loyaltyPointValueXaf = 100000` passait la validation et transformait chaque
 * point distribué en 100 000 XAF de dette, sans qu'aucun contrôle ne s'y
 * oppose. Les valeurs retenues ne sont pas des limites techniques mais des
 * garde-fous de bon sens — largement au-dessus de tout usage légitime, assez
 * bas pour arrêter une faute de frappe.
 */
export const PLATFORM_SETTINGS_BOUNDS = {
  /** 1 000 XAF le point serait déjà dix fois le tarif retenu. */
  MAX_POINT_VALUE_XAF: 1000,
  /** Au-delà de 10 points par commande, ce n'est plus de la fidélité. */
  MAX_POINTS_PER_ORDER: 10,
  /** Un seuil de rachat au-delà de 500 points rendrait le programme inerte. */
  MAX_MIN_REDEMPTION: 500,
  /** Même raisonnement que le forfait de commande, côté parrainage. */
  MAX_REFERRER_BONUS: 50,
} as const;

export class UpdatePlatformSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  serviceFeePercent?: number;

  /**
   * COMMISSION VENDEUR par défaut, en pourcentage.
   *
   * ⚠️ **Ce champ manquait**, et son absence était invisible. Le
   * `ValidationPipe` global tourne en `whitelist: true` avec
   * `forbidNonWhitelisted: false` : un `PATCH` portant
   * `restaurantCommissionPercent` répondait **200 OK sans rien changer**, le
   * champ étant retiré du corps avant d'atteindre le service. Passer la
   * commission à 0 % imposait donc une écriture SQL directe.
   *
   * Ne s'applique qu'aux commandes **futures** : le taux est figé sur chaque
   * commande à sa création (`Order.commissionPercent`), et c'est ce snapshot
   * que lit le reversement. Modifier ce réglage ne réécrit aucun montant passé.
   *
   * Surchargé par vendeur via `PATCH /admin/vendors/:id/commerce`.
   * Borné comme lui à `MAX_COMMISSION_PERCENT` — au-delà,
   * `percentToBasisPoints` écrêterait en silence et le taux affiché ne serait
   * pas celui appliqué.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_COMMISSION_PERCENT)
  restaurantCommissionPercent?: number;

  /**
   * Forfait de points gagné par commande livrée.
   *
   * A remplacé `loyaltyPointsPer100Xaf` (gain proportionnel au montant), qui
   * ne pouvait pas exprimer un forfait quelle qu'ait été sa valeur.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PLATFORM_SETTINGS_BOUNDS.MAX_POINTS_PER_ORDER)
  loyaltyPointsPerOrder?: number;

  /**
   * ⚠️ **Champ le plus lourd de conséquences du back-office.**
   *
   * Il est lu au moment de la dépense, jamais figé à l'acquisition : le
   * modifier revalorise instantanément **tout le passif déjà distribué**. Le
   * multiplier par dix multiplie par dix la dette de la plateforme envers ses
   * clients, sans qu'aucune commande n'ait été passée.
   *
   * Ne jamais le changer sans exécuter d'abord
   * `scripts/db/redenominate-loyalty.js` (procédure : `docs/LOYALTY.md`).
   * Le changement est journalisé dans `AdminAuditLog`.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PLATFORM_SETTINGS_BOUNDS.MAX_POINT_VALUE_XAF)
  loyaltyPointValueXaf?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PLATFORM_SETTINGS_BOUNDS.MAX_MIN_REDEMPTION)
  loyaltyMinRedemption?: number;

  /** Récompense du parrain à la première commande livrée de son filleul. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PLATFORM_SETTINGS_BOUNDS.MAX_REFERRER_BONUS)
  referrerBonusPoints?: number;

  @IsOptional()
  @IsBoolean()
  maintenanceMode?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  maintenanceMessage?: string;

  // ── Pilotage du parc installé ────────────────────────────────────────────
  //
  // `APP_VERSION_PATTERN` refuse tout ce qui n'est pas `major.minor.patch`
  // (+build optionnel). Ce n'est pas du zèle : `minAppVersion` peut **bloquer
  // l'application** de tous les clients, et une valeur acceptée « au mieux »
  // — « 1.2 », « 1.3.x », « v2 beta » — produirait un seuil valide à partir
  // d'une faute de frappe. Les applications parsent tout aussi strictement et
  // ignorent ce qu'elles ne comprennent pas ; le refus ici permet à
  // l'administrateur de voir son erreur au lieu d'un réglage sans effet.

  /**
   * ⚠️ Seul réglage de cette table capable d'empêcher un client de commander.
   * Réservé à une faille de sécurité ou une rupture de contrat d'API. Pour
   * pousser une nouveauté, utiliser `latestAppVersion`, qui laisse repousser.
   */
  @IsOptional()
  @Matches(APP_VERSION_PATTERN, {
    message:
      'minAppVersion doit être au format major.minor.patch (ex : 1.3.0 ou 1.3.0+41).',
  })
  minAppVersion?: string;

  @IsOptional()
  @Matches(APP_VERSION_PATTERN, {
    message:
      'latestAppVersion doit être au format major.minor.patch (ex : 1.3.0 ou 1.3.0+41).',
  })
  latestAppVersion?: string;

  @IsOptional()
  @IsUrl(
    {
      protocols: ['https', 'market'],
      require_protocol: true,
      require_tld: false, // market://details?id=x n'a pas de TLD, contrairement à https://
    },
    { message: 'updateUrlAndroid doit être une URL https ou market complète.' },
  )
  @MaxLength(500)
  updateUrlAndroid?: string;

  @IsOptional()
  @IsUrl(
    { protocols: ['https', 'itms-apps'], require_protocol: true },
    { message: 'updateUrlIos doit être une URL https ou itms-apps complète.' },
  )
  @MaxLength(500)
  updateUrlIos?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  updateMessage?: string;
}
