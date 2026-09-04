import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Corps des callbacks pawaPay (dépôt et reversement).
 *
 * ⚠️ Ce DTO est **la** validation de cet endpoint : il est `@Public()`, donc
 * aucun garde ne s'exécute avant lui. Un payload typé par une simple interface
 * TypeScript ne serait pas validé du tout au runtime — c'était le défaut du
 * webhook MTN avant le correctif du 27/08/2026.
 *
 * Le corps d'un callback reprend la forme de l'objet `data` renvoyé par les
 * routes de consultation, avec deux montants : `requestedAmount` (ce que nous
 * avons demandé) et `amount` (ce qui a été mouvementé).
 *
 * Les champs sont volontairement permissifs sur le contenu et stricts sur le
 * type : ce n'est pas le rôle du DTO de décider si le statut est terminal, mais
 * il doit garantir qu'aucune valeur inattendue n'atteint Prisma.
 */

class PawaPayAccountDetailsDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneNumber?: string;

  /**
   * La documentation officielle écrit `phoneNUmber` (N majuscule) dans ses
   * exemples de réponse. On accepte les deux graphies : ni leur correction, ni
   * son absence, ne doit faire échouer la lecture d'un callback qui porte de
   * l'argent.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneNUmber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  provider?: string;
}

class PawaPayPartyDto {
  @IsOptional()
  @IsString()
  @MaxLength(16)
  type?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PawaPayAccountDetailsDto)
  accountDetails?: PawaPayAccountDetailsDto;
}

class PawaPayFailureReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  failureCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  failureMessage?: string;
}

/**
 * Statuts **connus** de pawaPay, pour la documentation et les tests.
 *
 * ⚠️ Cette liste n'est **pas** une contrainte de validation, et ne doit jamais
 * le redevenir. Elle l'a été (`@IsIn`), et c'était un défaut de conception :
 *
 *  - le DTO refusait par une `400` tout statut hors liste ;
 *  - `mapPawaPayState` traite au contraire n'importe quelle valeur inconnue
 *    comme « pas encore décidé » — donc sans aucune transition métier ;
 *  - un `400` fait rejouer pawaPay pendant quinze minutes, puis abandonner,
 *    **sans qu'aucune ligne ne soit écrite nulle part** : ni `PaymentEvent`, ni
 *    log applicatif, la validation s'exécutant avant le handler.
 *
 * pawaPay documente au moins `SUBMITTED`, `REJECTED` et `DUPLICATE_IGNORED` en
 * plus des six ci-dessous, et peut en ajouter sans nous prévenir. Un statut que
 * nous ne connaissons pas doit être **reçu, tracé, et laissé sans effet** — pas
 * refusé en silence. Refuser, ici, c'est perdre l'information définitivement.
 */
export const PAWAPAY_KNOWN_STATUSES = [
  'ACCEPTED',
  'ENQUEUED',
  'SUBMITTED',
  'PROCESSING',
  'IN_RECONCILIATION',
  'COMPLETED',
  'FAILED',
  'REJECTED',
  'DUPLICATE_IGNORED',
] as const;

export class PawaPayCallbackDto {
  /** Présent sur un callback de dépôt. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  depositId?: string;

  /** Présent sur un callback de reversement. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  payoutId?: string;

  /**
   * Statut brut du prestataire. Contraint en **type** (chaîne bornée), jamais
   * en **valeur** — voir `PAWAPAY_KNOWN_STATUSES`.
   */
  @IsString()
  @IsNotEmpty({ message: 'status requis' })
  @MaxLength(64)
  status!: string;

  /** Montant mouvementé, en chaîne décimale. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  amount?: string;

  /** Montant demandé à l'initiation — privilégié pour le contrôle anti-écart. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  requestedAmount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  country?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PawaPayPartyDto)
  payer?: PawaPayPartyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PawaPayPartyDto)
  recipient?: PawaPayPartyDto;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientReferenceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  customerMessage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  created?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  providerTransactionId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PawaPayFailureReasonDto)
  failureReason?: PawaPayFailureReasonDto;

  /** En lecture, pawaPay renvoie un objet — alors que la requête prend un tableau. */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;
}
