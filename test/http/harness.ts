import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

/**
 * Lot 4 (4B-2, J7, OD-15) — harnais HTTP : l'application Nest **réelle**
 * (`AppModule`, gardes globales, pipe et filtre de `main.ts`), sur une base
 * PostgreSQL et un Redis locaux jetables. Deux frontières seulement sont
 * doublées :
 *
 *  · **Firebase Auth** : `verifyIdToken` accepte des jetons `test:<uid>` (le
 *    reste de l'authentification — utilisateur en base, rôle, capacités,
 *    second facteur — est le code réel) ;
 *  · **pawaPay** : un faux serveur HTTP local répond à `PAWAPAY_API_URL`
 *    (le client axios et le mapper sont réels), et ses callbacks sont
 *    **signés** RFC-9421 (ECDSA P-256) puis vérifiés par le code réel contre
 *    une clé publique de test.
 *
 * ⚠️ Aucun `.env` n'est lu : `ConfigModule` cherche ses fichiers dans le
 * dossier courant, que le harnais déplace dans un dossier temporaire vide
 * AVANT de charger `AppModule`. Le `.env` du dépôt peut viser la production.
 */

export const DATABASE_URL = process.env.TEST_DATABASE_URL;
/** Redis local, base dédiée : vidée au démarrage du harnais. */
export const REDIS_URL = process.env.TEST_REDIS_URL;

/**
 * Le harnais tronque des tables et vide une base Redis : il refuse toute
 * cible qui n'est pas sur cette machine (CI comprise, `localhost`).
 */
export function assertLocalTargets(): void {
  for (const [name, url] of [
    ['TEST_DATABASE_URL', DATABASE_URL],
    ['TEST_REDIS_URL', REDIS_URL],
  ] as const) {
    const host = url ? new URL(url).hostname : '';
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
      throw new Error(
        `${name} doit viser une base locale jetable (reçu : ${host || 'rien'}).`,
      );
    }
  }
}

// ─── Clé de signature des callbacks (jetable, générée à chaque exécution) ────

const callbackKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const CALLBACK_PUBLIC_KEY = callbackKeys.publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString();

// ─── Faux pawaPay (appels sortants) ─────────────────────────────────────────

export interface FakePawaPayCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export class FakePawaPay {
  readonly calls: FakePawaPayCall[] = [];
  /** Réponse au prochain dépôt ou versement (défaut : `ACCEPTED`). */
  nextStatus: 'ACCEPTED' | 'REJECTED' = 'ACCEPTED';
  /**
   * Transactions que le prestataire déclare connaître à la consultation
   * (`GET /v2/deposits/:id`, `/v2/payouts/:id`) — un callback perdu.
   */
  private readonly known = new Map<string, Record<string, unknown>>();
  private server: Server | null = null;

  /** Le prestataire connaît désormais cette transaction (consultation). */
  know(id: string, transaction: Record<string, unknown>): void {
    this.known.set(id, transaction);
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  reset(): void {
    this.calls.length = 0;
    this.nextStatus = 'ACCEPTED';
    this.known.clear();
  }

  /** Corps des appels `POST <path>` reçus. */
  posted(path: string): Record<string, unknown>[] {
    return this.calls
      .filter((c) => c.method === 'POST' && c.path === path)
      .map((c) => c.body ?? {});
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const path = (req.url ?? '').split('?')[0];
    this.calls.push({ method: req.method ?? '', path, body });

    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'POST' && path === '/v2/deposits') {
      return reply(200, {
        depositId: body?.depositId,
        status: this.nextStatus,
        ...(this.nextStatus === 'REJECTED'
          ? { failureReason: { failureCode: 'PAYER_NOT_FOUND' } }
          : { created: new Date().toISOString() }),
      });
    }
    if (req.method === 'POST' && path === '/v2/payouts') {
      return reply(200, {
        payoutId: body?.payoutId,
        status: this.nextStatus,
        ...(this.nextStatus === 'REJECTED'
          ? { failureReason: { failureCode: 'RECIPIENT_NOT_FOUND' } }
          : { created: new Date().toISOString() }),
      });
    }
    // Consultations : `FOUND` pour ce que le test a déclaré connu, sinon le
    // prestataire ne sait rien (la vérité arrive par les callbacks signés).
    const lookup = /^\/v2\/(deposits|payouts)\/([^/]+)$/.exec(path);
    const known = lookup && this.known.get(decodeURIComponent(lookup[2]));
    if (req.method === 'GET' && known) {
      return reply(200, { status: 'FOUND', data: known });
    }
    return reply(404, { status: 'NOT_FOUND' });
  }
}

// ─── Authentification de test ───────────────────────────────────────────────

const TEST_SIGNATURE = 'signature-de-test';
const b64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Jeton accepté par le double de Firebase pour cet utilisateur. Au format
 * JWT, comme un vrai jeton Firebase : le limiteur de débit lit son `sub`
 * avant toute vérification (`resolveThrottlerTracker`) — un jeton opaque
 * mettrait tous les utilisateurs dans le même compteur.
 */
export const tokenFor = (firebaseUid: string) =>
  `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: firebaseUid })}.${TEST_SIGNATURE}`;

/**
 * Double de `FirebaseService` : seule la vérification du jeton est simulée.
 * Le jeton porte un second facteur récent (MFA admin), comme un admin enrôlé.
 */
function fakeFirebase() {
  const verifyIdToken = async (token: string) => {
    const [, payload, signature] = token.split('.');
    if (signature !== TEST_SIGNATURE || !payload) {
      throw Object.assign(new Error('jeton inconnu'), {
        code: 'auth/argument-error',
      });
    }
    const uid = (
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        sub: string;
      }
    ).sub;
    return {
      uid,
      sub: uid,
      auth_time: Math.floor(Date.now() / 1000),
      firebase: { sign_in_provider: 'password', sign_in_second_factor: 'totp' },
    };
  };
  const unavailable = () => {
    throw new Error('Firebase indisponible dans le harnais HTTP');
  };
  return {
    getAuth: () => ({ verifyIdToken, getUser: unavailable }),
    getMessaging: () => ({
      send: unavailable,
      sendEachForMulticast: unavailable,
    }),
    isReady: () => false,
    revokeUserTokens: async () => undefined,
    setUserDisabled: async () => undefined,
    generatePasswordResetLink: unavailable,
    deleteUserSafe: async () => undefined,
  };
}

// ─── Application ────────────────────────────────────────────────────────────

export interface HttpHarness {
  app: INestApplication;
  pawapay: FakePawaPay;
  /** Requête authentifiée au nom de `firebaseUid` (ou anonyme). */
  http: (firebaseUid?: string) => AuthedAgent;
  /**
   * Un passage du dépileur réel de l'outbox, comme le worker le ferait
   * (`RUN_BACKGROUND_JOBS` est relu à l'exécution, ouvert le temps du passage).
   */
  runOutbox: () => Promise<void>;
  /** Un passage du cron réel de réconciliation des paiements (même règle). */
  reconcilePayments: () => Promise<void>;
  /** Callback pawaPay signé, sur la route réelle du webhook. */
  callback: (
    route: 'deposits' | 'payouts',
    payload: Record<string, unknown>,
  ) => request.Test;
  close: () => Promise<void>;
}

type Verb = 'get' | 'post' | 'patch' | 'put' | 'delete';
export type AuthedAgent = Record<Verb, (url: string) => request.Test>;

export async function startHttpHarness(): Promise<HttpHarness> {
  assertLocalTargets();
  const pawapay = new FakePawaPay();
  const pawapayUrl = await pawapay.start();

  // Environnement complet, posé AVANT le chargement d'`AppModule` (la
  // validation Joi tourne à l'import). Rien n'est hérité d'un `.env`.
  process.chdir(mkdtempSync(join(tmpdir(), 'lilia-http-')));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL,
    DIRECT_URL: DATABASE_URL,
    REDIS_URL,
    RUN_BACKGROUND_JOBS: 'false',
    LOG_LEVEL: 'error',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    PAYMENT_MODE: 'PAWAPAY',
    PAWAPAY_API_URL: pawapayUrl,
    PAWAPAY_API_TOKEN: 'jeton-de-test',
    PAWAPAY_PUBLIC_KEY: CALLBACK_PUBLIC_KEY,
    PAWAPAY_CALLBACK_IPS: '',
    ADMIN_MFA_REQUIRED: 'true',
    PAYOUT_ACCOUNT_COOLDOWN_HOURS: '24',
    // `MtnMomoTokenService` valide sa configuration hors mode MANUAL, même
    // quand pawaPay encaisse : valeurs factices, et son API pointée sur le
    // faux serveur local — aucun appel ne part vers le sandbox MTN.
    MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY: 'cle-de-test',
    MTN_MOMO_CALLBACK_URL: 'http://127.0.0.1/mtn-callback',
    MTN_MOMO_BASE_URL: pawapayUrl,
    FIREBASE_PROJECT_ID: 'lilia-http-test',
    FIREBASE_CLIENT_EMAIL: 'test@lilia-http-test.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: 'non-utilisee',
    INFOBIP_API_KEY: '',
    RESEND_API_KEY: '',
    SENTRY_DSN: '',
    CLOUDINARY_URL: '',
  });

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { AppModule } =
    require('../../apps/lilia-app/src/app.module') as typeof import('../../apps/lilia-app/src/app.module');
  const { FirebaseService } =
    require('../../apps/lilia-app/src/modules/firebase/firebase.service') as typeof import('../../apps/lilia-app/src/modules/firebase/firebase.service');
  const { OutboxDispatcherService } =
    require('../../apps/lilia-app/src/modules/outbox/outbox-dispatcher.service') as typeof import('../../apps/lilia-app/src/modules/outbox/outbox-dispatcher.service');
  const { PaymentReconciliationService } =
    require('../../apps/lilia-app/src/modules/schedule/payment-reconciliation.service') as typeof import('../../apps/lilia-app/src/modules/schedule/payment-reconciliation.service');
  const { HttpExceptionFilter } =
    require('../../apps/lilia-app/src/common/exception-filters/http-exception.filter') as typeof import('../../apps/lilia-app/src/common/exception-filters/http-exception.filter');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(FirebaseService)
    .useValue(fakeFirebase())
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
    logger: ['error', 'warn'],
  });
  // Comme `main.ts`.
  app.set('trust proxy', 1);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  const server = app.getHttpServer();

  const http = (firebaseUid?: string): AuthedAgent => {
    const verb =
      (v: Verb) =>
      (url: string): request.Test => {
        const req = request(server)[v](url);
        return firebaseUid
          ? req.set('Authorization', `Bearer ${tokenFor(firebaseUid)}`)
          : req;
      };
    return {
      get: verb('get'),
      post: verb('post'),
      patch: verb('patch'),
      put: verb('put'),
      delete: verb('delete'),
    };
  };

  const callback = (
    route: 'deposits' | 'payouts',
    payload: Record<string, unknown>,
  ) => {
    const path = `/webhooks/pawapay/${route}`;
    const body = JSON.stringify(payload);
    return request(server).post(path).set(signCallback(path, body)).send(body);
  };

  const asWorker = async (job: () => Promise<void>) => {
    process.env.RUN_BACKGROUND_JOBS = 'true';
    try {
      await job();
    } finally {
      process.env.RUN_BACKGROUND_JOBS = 'false';
    }
  };

  return {
    app,
    pawapay,
    http,
    runOutbox: () =>
      asWorker(() => app.get(OutboxDispatcherService).dispatchPending()),
    reconcilePayments: () =>
      asWorker(() => app.get(PaymentReconciliationService).reconcile()),
    callback,
    // ⚠️ `app.close()` laisse ouverts le pool `pg` de l'application et une
    // connexion Redis (mesuré le 19/11, `backlog.md`) : le script
    // `test:http` passe `--forceExit`. À retirer quand l'arrêt les fermera.
    close: async () => {
      await app.close();
      await pawapay.stop();
    },
  };
}

/**
 * En-têtes RFC-9421 d'un callback pawaPay, signés avec la clé de test. Même
 * forme que pawaPay (`Signature-Input` couvrant méthode, autorité, chemin,
 * date de signature, empreinte et type de contenu).
 *
 * L'autorité signée est celle que lit le serveur (`req.get('host')`) : le
 * harnais force l'en-tête `Host` à la valeur signée.
 */
function signCallback(path: string, body: string): Record<string, string> {
  const contentType = 'application/json';
  const contentDigest = `sha-512=:${createHash('sha512').update(body).digest('base64')}:`;
  const signatureDate = new Date().toISOString();
  const params = `("@method" "@authority" "@path" "signature-date" "content-digest" "content-type");alg="ecdsa-p256-sha256";keyid="lilia-http-test";created=${Math.floor(Date.now() / 1000)}`;
  const authority = 'lilia-http-test.local';
  const base = [
    `"@method": POST`,
    `"@authority": ${authority}`,
    `"@path": ${path}`,
    `"signature-date": ${signatureDate}`,
    `"content-digest": ${contentDigest}`,
    `"content-type": ${contentType}`,
    `"@signature-params": ${params}`,
  ].join('\n');
  const signature = createSign('sha256')
    .update(base, 'utf8')
    .sign({ key: callbackKeys.privateKey, dsaEncoding: 'der' })
    .toString('base64');
  return {
    Host: authority,
    'Content-Type': contentType,
    'Content-Digest': contentDigest,
    'Signature-Date': signatureDate,
    'Signature-Input': `sig-pp=${params}`,
    Signature: `sig-pp=:${signature}:`,
  };
}

/** Clé d'idempotence unique pour `POST /reservations`. */
export const idempotencyKey = () => randomUUID();
