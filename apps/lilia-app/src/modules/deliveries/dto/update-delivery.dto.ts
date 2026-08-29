import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DriverStatus } from '@prisma/client';

export class SetDriverStatusDto {
  @IsEnum(DriverStatus)
  status: DriverStatus;
}

/**
 * Miroir HTTP de l'enum Prisma `DeliveryStatus`.
 *
 * `ACCEPTER` sépare « le livreur a accepté et va chercher le repas » de
 * « le livreur roule avec le repas » (EN_TRANSIT). Sans cette distinction,
 * accepter une mission faisait basculer la commande en EN_ROUTE et prévenait
 * le client que sa commande était en chemin — alors que rien n'avait quitté le
 * restaurant.
 *
 * ⚠️ `ACCEPTER` et `EN_TRANSIT` ne sont PAS atteignables via
 * `PATCH /:id/status` : ils passent par `/accept` et `/pickup`, qui portent les
 * effets de bord sur la commande et le statut du livreur.
 */
export enum DeliveryStatus {
  EN_ATTENTE = 'EN_ATTENTE',
  ASSIGNER = 'ASSIGNER',
  ACCEPTER = 'ACCEPTER',
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
