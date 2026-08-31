import { Type } from 'class-transformer';
import {
  IsIn,
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
 * Statuts qu'un callback peut porter. pawaPay ne rappelle qu'aux états
 * **terminaux**, mais on accepte l'ensemble : refuser un statut intermédiaire
 * par une 400 le ferait rejouer pendant 15 minutes pour rien.
 */
export const PAWAPAY_CALLBACK_STATUSES = [
  'ACCEPTED',
  'ENQUEUED',
  'PROCESSING',
  'IN_RECONCILIATION',
  'COMPLETED',
  'FAILED',
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

  @IsString()
  @IsNotEmpty({ message: 'status requis' })
  @IsIn(PAWAPAY_CALLBACK_STATUSES as unknown as string[], {
    message: 'statut pawaPay inconnu',
  })
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
