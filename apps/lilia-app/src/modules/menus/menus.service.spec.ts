import { Test, TestingModule } from '@nestjs/testing';
import { MenusService } from './menus.service';
import { MenuQueryService } from './menu-query.service';
import { MenuCommandService } from './menu-command.service';
import { MenuLifecycleService } from './menu-lifecycle.service';

/**
 * Smoke test DI MenusService (LIL-106, mis à jour LIL-141).
 *
 * Depuis LIL-141, MenusService est une façade qui délègue à MenuQueryService
 * (lectures), MenuCommandService (création / mise à jour) et
 * MenuLifecycleService (suppression / stock / activation) — on mocke donc ces
 * trois deps directes, sans bootstrap du module complet (évite de pull
 * `RolesGuard` / `FirebaseAuthGuard` globaux). Pattern identique à
 * `admin.service.spec.ts`.
 */
describe('MenusService', () => {
  let service: MenusService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MenusService,
        { provide: MenuQueryService, useValue: {} },
        { provide: MenuCommandService, useValue: {} },
        { provide: MenuLifecycleService, useValue: {} },
      ],
    }).compile();

    service = module.get<MenusService>(MenusService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
