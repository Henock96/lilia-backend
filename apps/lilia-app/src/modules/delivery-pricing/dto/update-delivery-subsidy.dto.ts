import { DeliverySubsidyMode } from '@prisma/client';
import { IsEnum, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { MAX_DELIVERY_FEE_XAF } from './delivery-tariff-draft.dto';

/**
 * `PATCH /vendors/:id/delivery-subsidy` (F3-02, R-02.4).
 *
 * Le vendeur ne fixe pas le prix de la course : il en offre une part à son
 * client, retenue sur son reversement. Le montant n'est jamais plafonné ici au
 * prix de base — la grille peut changer ; c'est le moteur qui borne, commande
 * par commande.
 */
export class UpdateDeliverySubsidyDto {
  @IsEnum(DeliverySubsidyMode)
  mode: DeliverySubsidyMode;

  /** Part offerte à chaque commande livrée (mode `FIXED`). */
  @ValidateIf((o: UpdateDeliverySubsidyDto) => o.mode === 'FIXED')
  @IsInt({ message: 'amountXaf doit être un entier (XAF).' })
  @Min(1)
  @Max(MAX_DELIVERY_FEE_XAF)
  amountXaf?: number;

  /** Livraison offerte à partir de ce sous-total (mode `FREE_ABOVE`). */
  @ValidateIf((o: UpdateDeliverySubsidyDto) => o.mode === 'FREE_ABOVE')
  @IsInt({ message: 'thresholdXaf doit être un entier (XAF).' })
  @Min(1)
  @Max(10_000_000)
  thresholdXaf?: number;
}
