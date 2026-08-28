import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Payload du callback MTN MoMo.
 *
 * Était typé par une simple `interface` TypeScript, qui n'existe pas au
 * runtime : le `ValidationPipe` global ne validait donc **rien** sur ce
 * endpoint `@Public()`. Un payload malformé partait jusqu'à Prisma, où
 * l'erreur était attrapée et masquée en `200 OK` — panne silencieuse.
 */
export enum MtnWebhookStatus {
  SUCCESSFUL = 'SUCCESSFUL',
  FAILED = 'FAILED',
  PENDING = 'PENDING',
}

export class MtnWebhookDto {
  @IsString()
  @IsNotEmpty({ message: 'referenceId requis' })
  @MaxLength(128)
  referenceId: string;

  @IsEnum(MtnWebhookStatus, { message: 'status MTN inconnu' })
  status: MtnWebhookStatus;

  @IsString()
  @MaxLength(128)
  @IsOptional()
  financialTransactionId?: string;
}
