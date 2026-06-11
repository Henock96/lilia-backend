/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { CreateMenuDto, UpdateMenuDto } from './dto';
import { MenuQueryService } from './menu-query.service';
import { MenuCommandService } from './menu-command.service';
import { MenuLifecycleService } from './menu-lifecycle.service';

/**
 * Façade menus (LIL-141).
 *
 * Conserve l'API publique historique consommée par MenusController et délègue
 * aux services focalisés :
 *  - lectures              → MenuQueryService
 *  - création / mise à jour → MenuCommandService
 *  - suppression / stock / activation → MenuLifecycleService
 */
@Injectable()
export class MenusService {
  constructor(
    private readonly query: MenuQueryService,
    private readonly command: MenuCommandService,
    private readonly lifecycle: MenuLifecycleService,
  ) {}

  // ─── Écritures ─────────────────────────────────────────────────────────────

  create(dto: CreateMenuDto, firebaseUid: string) {
    return this.command.create(dto, firebaseUid);
  }

  update(id: string, dto: UpdateMenuDto, firebaseUid: string) {
    return this.command.update(id, dto, firebaseUid);
  }

  remove(id: string, firebaseUid: string) {
    return this.lifecycle.remove(id, firebaseUid);
  }

  updateStock(menuId: string, stockQuotidien: number | null, firebaseUid: string) {
    return this.lifecycle.updateStock(menuId, stockQuotidien, firebaseUid);
  }

  toggleActive(id: string, firebaseUid: string) {
    return this.lifecycle.toggleActive(id, firebaseUid);
  }

  // ─── Lectures ──────────────────────────────────────────────────────────────

  findAll(filters?: {
    restaurantId?: string;
    isActive?: boolean;
    includeExpired?: boolean;
  }) {
    return this.query.findAll(filters);
  }

  getActiveMenus(restaurantId?: string) {
    return this.query.getActiveMenus(restaurantId);
  }

  findOne(id: string) {
    return this.query.findOne(id);
  }

  findByRestaurant(firebaseUid: string) {
    return this.query.findByRestaurant(firebaseUid);
  }
}
