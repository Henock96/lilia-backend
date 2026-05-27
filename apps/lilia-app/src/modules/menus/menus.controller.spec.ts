import { Test, TestingModule } from '@nestjs/testing';
import { MenusController } from './menus.controller';
import { MenusService } from './menus.service';

/**
 * Smoke test DI MenusController (LIL-106).
 *
 * Mocke uniquement la dep directe (MenusService). Les guards globaux
 * (`FirebaseAuthGuard`, `RolesGuard`) ne sont pas chargés ici car
 * `Test.createTestingModule` n'instancie pas les `APP_GUARD` du `AuthModule`.
 */
describe('MenusController', () => {
  let controller: MenusController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MenusController],
      providers: [{ provide: MenusService, useValue: {} }],
    }).compile();

    controller = module.get<MenusController>(MenusController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
