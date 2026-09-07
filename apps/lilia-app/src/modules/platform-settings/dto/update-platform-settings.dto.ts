import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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
}
