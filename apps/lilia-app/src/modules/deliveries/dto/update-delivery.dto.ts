import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum DeliveryStatus {
  EN_ATTENTE = 'EN_ATTENTE',
  ASSIGNER = 'ASSIGNER',
  EN_TRANSIT = 'EN_TRANSIT',
  LIVRER = 'LIVRER',
  ECHEC = 'ECHEC',
}

export class UpdateDeliveryStatusDto {
  @IsEnum(DeliveryStatus)
  status: DeliveryStatus;
}

export class AssignDeliveryDto {
  @IsString()
  delivererId: string;
}
