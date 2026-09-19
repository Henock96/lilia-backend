import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DriverSettlementMethod } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class OutstandingQueryDto {
  /**
   * Coupure du décompte. Omise ⇒ maintenant.
   *
   * Elle existe pour que l'aperçu et l'enregistrement portent sur **exactement
   * le même ensemble** de courses : l'administrateur lit un montant à un
   * instant, puis le rejoue à l'écriture.
   */
  @ApiPropertyOptional({ description: 'ISO 8601' })
  @IsOptional()
  @IsDateString()
  coveredUntil?: string;
}

export class RecordSettlementDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  driverId: string;

  /**
   * ⚠️ **Obligatoire, et c'est le point de tout le modèle.**
   *
   * Sans elle, l'enregistrement couvrirait « tout ce qui est non réglé
   * maintenant » — donc les courses terminées pendant que l'administrateur
   * allait remettre l'argent. Elles seraient absorbées dans un montant déjà
   * convenu, et le livreur sous-payé sans que rien ne le signale.
   *
   * On y remet la valeur rendue par l'aperçu consulté.
   */
  @ApiProperty({ description: 'ISO 8601 — la coupure de l’aperçu consulté' })
  @IsDateString()
  coveredUntil: string;

  @ApiProperty({ enum: DriverSettlementMethod })
  @IsEnum(DriverSettlementMethod)
  method: DriverSettlementMethod;

  /**
   * Instant réel de la remise. Omis ⇒ maintenant.
   * Distinct de l'enregistrement : un versement d'hier saisi ce matin doit
   * porter la date d'hier, sinon toute lecture par période est fausse.
   */
  @ApiPropertyOptional({ description: 'ISO 8601' })
  @IsOptional()
  @IsDateString()
  paidAt?: string;

  /** Numéro de transaction Mobile Money, numéro de reçu. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class CancelSettlementDto {
  /** Obligatoire : annuler une pièce financière sans motif est intraçable. */
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason: string;
}
