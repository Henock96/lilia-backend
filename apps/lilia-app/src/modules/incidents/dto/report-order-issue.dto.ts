import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Ce que le client peut signaler sur SA commande (F-06).
 *
 * Une liste fermée plutôt que les onze types d'incident : un client n'a pas à
 * qualifier un « accident livreur » ni un « stock » — il dit ce qu'il constate.
 */
export const CUSTOMER_ISSUE_KINDS = [
  'NOT_RECEIVED', // commande déclarée livrée, jamais reçue
  'WRONG_ORDER', // reçue, mais pas la bonne / incomplète
  'LATE', // toujours en route, très en retard
  'OTHER',
] as const;
export type CustomerIssueKind = (typeof CUSTOMER_ISSUE_KINDS)[number];

export class ReportOrderIssueDto {
  @IsIn(CUSTOMER_ISSUE_KINDS)
  kind: CustomerIssueKind;

  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Le message est limité à 1000 caractères.' })
  message?: string;
}
