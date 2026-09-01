import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';

import { PaymentController } from './controllers/payment.controller';
import { PaymentService } from './services/payment.service';
import { PaymentEventService } from './services/payment-event.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PawaPayHttpService } from './providers/pawapay/pawapay-http.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';

/**
 * Liaison HTTP de l'en-tête de capacité — et rien d'autre.
 *
 * Les tests de service prouvent que la garde décide bien ; ils appellent
 * `createPayment(dto, uid, flow)` à la main et ne peuvent donc **rien** dire
 * du chemin réel : nom de l'en-tête, casse, décorateur `@Headers`. Or c'est
 * exactement là que ce mécanisme casse — une lettre de différence et tous les
 * clients à jour sont refusés en 426 alors qu'ils s'annoncent correctement.
 *
 * On monte donc le contrôleur dans une vraie application Nest et on envoie de
 * vraies requêtes. Le service est simulé : ce qui est vérifié ici, c'est ce qui
 * lui **parvient**.
 */
describe('POST /payments — transport de X-Lilia-Payment-Flow', () => {
  let app: INestApplication;
  const createPayment = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: { createPayment } },
        {
          provide: PaymentProviderRegistry,
          useValue: { currentMode: 'PAWAPAY' },
        },
        { provide: PawaPayHttpService, useValue: {} },
        { provide: PaymentEventService, useValue: {} },
        { provide: AdminAuditService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // `@FirebaseUser()` lit `request.firebaseUser`, normalement peuplé par le
    // `FirebaseAuthGuard` global — absent d'un module de test ne montant que ce
    // contrôleur. On simule l'utilisateur authentifié : ce qui est vérifié ici
    // est le transport de l'en-tête, pas l'authentification (couverte
    // ailleurs, et confirmée en 401 sur un serveur réel).
    app.use(
      (req: Record<string, unknown>, _res: unknown, next: () => void): void => {
        req.firebaseUser = { uid: 'uid-1' };
        next();
      },
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    createPayment.mockReset().mockResolvedValue({ paymentId: 'pay-1' });
  });

  /** Troisième argument reçu par le service = la capacité transmise. */
  const capabilitySeenByService = () =>
    createPayment.mock.calls[0]?.[2] as string | undefined;

  const post = (headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .post('/payments')
      .set(headers)
      .send({ orderId: 'o1', phoneNumber: '061234567' });

  it('transmet la capacité au service', async () => {
    await post({ 'X-Lilia-Payment-Flow': 'provider' }).expect(200);
    expect(capabilitySeenByService()).toBe('provider');
  });

  it('la casse de l’en-tête n’a pas d’importance (HTTP l’ignore)', async () => {
    // Les clients écrivent `X-Lilia-Payment-Flow`, le décorateur lit
    // `x-lilia-payment-flow`. Si Nest ne normalisait pas, chaque client à jour
    // serait refusé.
    await post({ 'x-LILIA-payment-FLOW': 'provider' }).expect(200);
    expect(capabilitySeenByService()).toBe('provider');
  });

  it('absent → `undefined`, ce que la garde interprète comme un vieux client', async () => {
    await post().expect(200);
    expect(capabilitySeenByService()).toBeUndefined();
  });

  it('un en-tête voisin ne passe pas pour la capacité', async () => {
    await post({ 'X-Lilia-Payment': 'provider' }).expect(200);
    expect(capabilitySeenByService()).toBeUndefined();
  });

  it('le corps reste intact — la capacité ne s’y mélange pas', async () => {
    await post({ 'X-Lilia-Payment-Flow': 'provider' }).expect(200);
    expect(createPayment.mock.calls[0][0]).toMatchObject({
      orderId: 'o1',
      phoneNumber: '061234567',
    });
  });
});
