import { DeliverySubsidyMode } from '@prisma/client';
import { UpdateDeliverySubsidyDto } from './dto/update-delivery-subsidy.dto';

/**
 * Colonnes `Restaurant` à écrire pour un réglage de subvention.
 *
 * Seule la valeur du mode choisi est conservée : un montant fixe resté en base
 * après un passage en « offerte dès X » ne servirait à rien et laisserait
 * croire, à la lecture, qu'il s'applique encore.
 */
export function deliverySubsidyData(dto: UpdateDeliverySubsidyDto): {
  deliverySubsidyMode: DeliverySubsidyMode;
  deliverySubsidyXaf: number | null;
  freeDeliveryThresholdXaf: number | null;
} {
  return {
    deliverySubsidyMode: dto.mode,
    deliverySubsidyXaf: dto.mode === 'FIXED' ? (dto.amountXaf ?? null) : null,
    freeDeliveryThresholdXaf:
      dto.mode === 'FREE_ABOVE' ? (dto.thresholdXaf ?? null) : null,
  };
}
