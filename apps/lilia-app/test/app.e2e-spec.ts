import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';

/**
 * Smoke test E2E minimaliste : démarrage du module + endpoint de santé public.
 *
 * - Vérifie que `AppModule` boot sans erreur (catch les régressions à
 *   l'import comme LIL-92 — uuid v9 ESM, BullMQ retiré, etc.)
 * - Vérifie que `GET /health` (public, sans Firebase auth) répond 200 et
 *   renvoie le shape minimum attendu par Render pour le check liveness
 */
describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health → 200 + status ok', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(res.body).toMatchObject({
      status: 'ok',
      timestamp: expect.any(String),
    });
  });
});
