import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IncidentStatus, MessageVisibility } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/**
 * Motifs qu'un client peut choisir (F3-06). Liste fermée : il dit ce qu'il
 * constate, l'administration qualifie (payeur, montant).
 */
export const CLAIM_REASONS = [
  'MISSING_ITEM',
  'WRONG_ITEM',
  'DAMAGED',
  'LATE',
  'OTHER',
] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];

/** Motifs qui n'ont de sens qu'avec des articles cochés. */
export const ITEM_CLAIM_REASONS: ClaimReason[] = [
  'MISSING_ITEM',
  'WRONG_ITEM',
  'DAMAGED',
];

/**
 * Photos : uniquement des images servies par NOTRE compte Cloudinary
 * (`POST /upload/image`). Une URL libre affichée dans le back-office serait un
 * lien arbitraire posé sous les yeux d'un administrateur.
 */
export const CLAIM_PHOTO_URL =
  /^https:\/\/res\.cloudinary\.com\/[\w-]+\/image\/upload\/[\w\-./%]+$/;

export class ClaimItemDto {
  @IsString()
  @MaxLength(64)
  orderItemId: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  quantity: number;
}

export class CreateClaimDto {
  @IsIn(CLAIM_REASONS)
  reason: ClaimReason;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ClaimItemDto)
  items?: ClaimItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Le message est limité à 1000 caractères.' })
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, { message: '3 photos au plus.' })
  @Matches(CLAIM_PHOTO_URL, {
    each: true,
    message: 'Photo invalide : utilisez l’envoi de photo de l’application.',
  })
  photoUrls?: string[];
}

export class PostClaimMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @Matches(CLAIM_PHOTO_URL, {
    each: true,
    message: 'Photo invalide : utilisez l’envoi de photo de l’application.',
  })
  attachments?: string[];

  /** ADMIN seulement ; imposé `STAFF_ONLY` au vendeur, `ALL` au client. */
  @IsOptional()
  @IsEnum(MessageVisibility)
  visibility?: MessageVisibility;
}

export class IssueVoucherDto {
  @IsInt()
  @Min(100)
  @Max(100_000)
  amountXaf: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  expiresInDays?: number;
}

export class RejectClaimDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class ClaimListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(IncidentStatus)
  status?: IncidentStatus;

  /** `open` = OPEN + IN_PROGRESS (la file de travail). */
  @IsOptional()
  @IsIn(['open', 'closed'])
  state?: 'open' | 'closed';
}
