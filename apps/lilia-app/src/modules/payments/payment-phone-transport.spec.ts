import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';

import { PaymentController } from './controllers/payment.controller';
import { PaymentService } from './services/payment.service';
import { PaymentEventService } from './services/payment-event.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PawaPayHttpService } from './providers/pawapay/pawapay-http.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';

/**
 * `POST /payments` à travers la vraie `ValidationPipe` — le numéro du payeur.
 *
 * Le test du DTO prouve que la règle normalise ; il ne dit rien de la pipe.
 * Or un `@Transform` n'a d'effet que si la pipe tourne avec `transform: true` :
 * c'est le réglage de `main.ts`, reproduit ici à l'identique. Ce qui est
 * vérifié, c'est le numéro qui **parvient** au service.
 *
 * Origine : le web et l'app envoient la saisie brute (`+242 06 123 45 67`) ;
 * la commande était créée, puis ce endpoint répondait 400 et l'encaissement ne
 * démarrait pas.
 */
describe('POST /payments — numéro saisi avec des séparateurs', () => {
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
    // Mêmes options que la pipe globale de `main.ts`.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    // Utilisateur authentifié simulé (cf. `payment-client-compat.spec.ts`).
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

  const post = (phoneNumber: string) =>
    request(app.getHttpServer())
      .post('/payments')
      .set('X-Lilia-Payment-Flow', 'provider')
      .send({ orderId: 'o1', phoneNumber });

  /** Premier argument reçu par le service = le DTO validé. */
  const phoneSeenByService = () =>
    (createPayment.mock.calls[0]?.[0] as { phoneNumber?: string } | undefined)
      ?.phoneNumber;

  it.each([
    ['+242 06 123 45 67', '+242061234567'],
    ['06 123 45 67', '061234567'],
    ['06-123-45-67', '061234567'],
  ])(
    'accepte « %s » et transmet « %s » au service',
    async (input, expected) => {
      await post(input).expect(200);
      expect(phoneSeenByService()).toBe(expected);
    },
  );

  it('transmet tel quel un numéro déjà compact', async () => {
    await post('+242061234567').expect(200);
    expect(phoneSeenByService()).toBe('+242061234567');
  });

  it('refuse toujours un numéro invalide, sans appeler le service', async () => {
    const res = await post('07 123 45 67').expect(400);
    expect(JSON.stringify(res.body)).toContain(
      'Numéro de téléphone congolais invalide (ex : 06 123 45 67)',
    );
    expect(createPayment).not.toHaveBeenCalled();
  });
});
