import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DriverStatus } from '@prisma/client';

export class SetDriverStatusDto {
  @IsEnum(DriverStatus)
  status: DriverStatus;
}

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

  /**
   * Motif, utile surtout sur `ECHEC` : il est repris dans la notification au
   * vendeur (qui doit décider s'il réassigne ou annule) et dans l'incident
   * tracé en supervision. Sans lui, l'échec n'était qu'un statut muet.
   */
  @IsString()
  @MaxLength(300, { message: 'Le motif est limité à 300 caractères' })
  @IsOptional()
  reason?: string;
}

export class AssignDeliveryDto {
  @IsString()
  delivererId: string;
}
