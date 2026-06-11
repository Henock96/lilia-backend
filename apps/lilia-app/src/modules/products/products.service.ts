/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { ProductType, VendorType } from '@prisma/client';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductQueryService } from './product-query.service';
import { ProductCommandService } from './product-command.service';

/**
 * Façade produits (LIL-143).
 *
 * Conserve l'API publique historique consommée par ProductsController et
 * délègue aux deux services focalisés :
 *  - lectures  → ProductQueryService
 *  - écritures → ProductCommandService
 *
 * La validation multi-vendeurs vit dans ProductValidatorService (déjà isolé).
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly query: ProductQueryService,
    private readonly command: ProductCommandService,
  ) {}

  // ─── Lectures ──────────────────────────────────────────────────────────────

  findAll(
    restaurantId?: string,
    categoryId?: string,
    page = 1,
    limit = 20,
    productType?: ProductType,
    vendorType?: VendorType,
  ) {
    return this.query.findAll(restaurantId, categoryId, page, limit, productType, vendorType);
  }

  findOne(id: string) {
    return this.query.findOne(id);
  }

  findPopular(limit = 10) {
    return this.query.findPopular(limit);
  }

  search(query: string, limit = 20) {
    return this.query.search(query, limit);
  }

  getRecommendations(firebaseUid: string, limit = 10) {
    return this.query.getRecommendations(firebaseUid, limit);
  }

  // ─── Écritures ─────────────────────────────────────────────────────────────

  create(dto: CreateProductDto, firebaseUid: string) {
    return this.command.create(dto, firebaseUid);
  }

  update(id: string, dto: UpdateProductDto, firebaseUid: string) {
    return this.command.update(id, dto, firebaseUid);
  }

  remove(id: string, firebaseUid: string) {
    return this.command.remove(id, firebaseUid);
  }

  updateStock(productId: string, stockQuotidien: number | null, firebaseUid: string) {
    return this.command.updateStock(productId, stockQuotidien, firebaseUid);
  }
}
