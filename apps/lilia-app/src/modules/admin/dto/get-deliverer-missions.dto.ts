/* eslint-disable prettier/prettier */
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { DeliveryStatus } from '@prisma/client';

/**
 * Statuts filtrables par l'admin pour l'historique des missions
 * d'un livreur. On exclut `ASSIGNER` côté API publique : la mission
 * « en cours » utilise déjà cet état mais l'app admin filtre la liste
 * via EN_ATTENTE / EN_TRANSIT / LIVRER / ECHEC.
 */
export const DELIVERER_MISSION_STATUSES = [
  DeliveryStatus.EN_ATTENTE,
  DeliveryStatus.EN_TRANSIT,
  DeliveryStatus.LIVRER,
  DeliveryStatus.ECHEC,
] as const;

export type DelivererMissionStatus = (typeof DELIVERER_MISSION_STATUSES)[number];

export class GetDelivererMissionsQueryDto {
  @IsOptional()
  @IsEnum(DeliveryStatus, {
    message:
      'status doit être l\'un de : EN_ATTENTE, EN_TRANSIT, LIVRER, ECHEC',
  })
  status?: DelivererMissionStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page doit être un entier' })
  @Min(1, { message: 'page doit être >= 1' })
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit doit être un entier' })
  @Min(1, { message: 'limit doit être >= 1' })
  @Max(100, { message: 'limit ne peut pas dépasser 100' })
  limit?: number = 20;
}
