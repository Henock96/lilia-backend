/* eslint-disable prettier/prettier */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { VendorsService } from './vendors.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';

/**
 * Smoke test DI VendorsService (LIL-115).
 *
 * Mocke les trois deps (PrismaService, PaginationService, EventEmitter2) —
 * pas de bootstrap du module complet pour éviter de pull les guards globaux.
 * Pattern identique à `admin.service.spec.ts` et `menus.service.spec.ts`.
 */
describe('VendorsService', () => {
  let service: VendorsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorsService,
        { provide: PrismaService, useValue: {} },
        { provide: PaginationService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<VendorsService>(VendorsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
