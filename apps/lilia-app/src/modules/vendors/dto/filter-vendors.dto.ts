import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { VendorType } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

// Note : filtre `quartier` reporté au Sprint C — il dépend de la logique
// deliveryZones (ZONE_BASED) vs FIXED qui mérite sa propre décision produit.
//
// `page` / `limit` viennent de `PaginationQueryDto` : ils y étaient redéclarés
// avec un plafond de 50, divergent de la borne commune. Cf. le commentaire de
// `AdminVendorFilterDto` — c'est ce genre d'écart qui rend un 400 inexplicable
// côté client.
export class FilterVendorsDto extends PaginationQueryDto {
  @IsEnum(VendorType)
  @IsOptional()
  vendorType?: VendorType;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  isOpen?: boolean;

  /**
   * Vendeurs mis en avant par l'administration.
   *
   * C'est ce filtre que consomme la section « Les plus courus » du site, qui
   * prenait jusqu'ici les quatre premiers de la liste — c'est-à-dire les quatre
   * derniers créés. L'interface annonçait une sélection éditoriale que personne
   * ne pouvait produire.
   */
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  isFeatured?: boolean;
}
