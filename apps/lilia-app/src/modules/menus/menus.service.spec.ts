import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MenusService } from './menus.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Smoke test DI MenusService (LIL-106).
 *
 * Mocke les deux deps directes (PrismaService, EventEmitter2) — pas de bootstrap
 * du module complet pour éviter de pull `RolesGuard` / `FirebaseAuthGuard` globaux.
 * Pattern identique à `admin.service.spec.ts`.
 */
describe('MenusService', () => {
  let service: MenusService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MenusService,
        { provide: PrismaService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<MenusService>(MenusService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
