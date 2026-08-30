# Worker BullMQ + migration FCM — design (LIL-38 + LIL-39)

Date : 2026-06-12 · Repo : `lilia-backend` · Parent : LIL-7 (sprint S3)
Branche cible : `hmipoka/lil-38-s3-setup-worker-bullmq-queue-notifications`
Statut : **design validé, implémentation différée**

## Tickets

- **LIL-38** [S3] Setup Worker BullMQ + queue `notifications` (3 j, High) :
  installer BullMQ + ioredis, configurer Redis dans `apps/worker/`, créer la
  queue `notifications` (FCM bulk), migrer 1 listener test, Bull Board UI,
  déployer Worker sur Render. Réf IMP-1. Related : LIL-135 (outbox).
- **LIL-39** [S3] Migrer FCM bulk listeners vers Worker BullMQ (1.5 j, High) :
  migrer tous les listeners EventEmitter FCM vers des jobs BullMQ (3 retries,
  backoff exponentiel), garder un fallback synchrone si Worker indispo, tests
  E2E event → job → FCM.

## Existant (audit)

- Monorepo Nest : `apps/lilia-app` (API, producteur d'events `@nestjs/event-emitter`)
  + `apps/worker` (skeleton « Hello World »). Pas de `libs/`, pas de path alias,
  pas de `render.yaml` (déploiement piloté au dashboard Render).
- FCM : `NotificationsService.sendPushNotification(userId, title, body, data?)`
  — résout les tokens en DB, envoie via Firebase Admin, nettoie les tokens
  invalides. Dépend de `PrismaService` + `FirebaseService`.
- Listeners FCM : `orders.listener` (client + resto), `payment.listener` (client),
  `menus.listener` (**bulk** → tous les anciens clients du resto),
  `vendors.listener` (**bulk** → admins). `user.listener` = email (hors scope FCM).
- Redis déjà présent : `ioredis`, `@nestjs-modules/ioredis`,
  `@nest-lab/throttler-storage-redis`, `RedisIoAdapter` (Socket.io).
  `REDIS_URL` **optionnel** (Joi `env.validation.ts`).
- `bullmq` / `@bull-board/*` **pas installés**.

## Décisions (validées avec le user)

1. **Partage de code** : alias tsconfig `@app/*` → `apps/lilia-app/src/*`. Le
   worker importe `FirebaseModule`/`PrismaModule`/`NotificationsModule` via
   l'alias (webpack bundle). **Aucun fichier lilia-app déplacé** (pas d'extraction
   vers `libs/`). Fallback si webpack ne résout pas l'alias : imports relatifs
   `../../lilia-app/src/...`.
2. **Bull Board** monté sur lilia-app `/admin/queues`. Auth = **HTTP Basic Auth**
   (`BULLBOARD_USER`/`BULLBOARD_PASSWORD`), PAS le `FirebaseAuthGuard` Bearer :
   Bull Board est une UI navigateur qui ne peut pas porter un Firebase ID token.
   Actif seulement si Redis configuré.
3. **Fallback** : `REDIS_URL` reste optionnel côté lilia-app. Sans Redis ou si
   `queue.add` échoue → `sendPushNotification` direct (comportement actuel
   préservé). Le **worker**, lui, échoue au boot sans `REDIS_URL`.

## Architecture cible

### Packages à ajouter
`bullmq`, `@nestjs/bullmq`, `@bull-board/api`, `@bull-board/express`,
`@bull-board/nestjs`.

### Code partagé
`tsconfig.json` racine : `paths: { "@app/*": ["apps/lilia-app/src/*"] }`.

`apps/lilia-app/src/modules/notifications/queue/notification-queue.constants.ts` :
```ts
export const NOTIFICATIONS_QUEUE = 'notifications';
export const PUSH_JOB = 'push';
export interface PushJobData {
  userId: string; title: string; body: string;
  data?: Record<string, string>;
}
```

### Producteur — `apps/lilia-app`
- **`NotificationQueueModule`** : si `REDIS_URL` présent → `BullModule.forRootAsync`
  (connexion ioredis, `maxRetriesPerRequest: null`) + `registerQueue({ name:
  NOTIFICATIONS_QUEUE })`. Sinon module sans connexion Bull.
- **`NotificationDispatcherService`** (point d'entrée unique des listeners) :
  ```
  send(userId, title, body, data?):
    queue présente ? -> queue.add(PUSH_JOB, payload, {
        attempts: 3, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, removeOnFail: 1000 })
    pas de queue / add throw -> notifications.sendPushNotification(...)  // fallback sync
  ```
  Queue injectée `@Optional() @InjectQueue(NOTIFICATIONS_QUEUE)`.
- **Listeners migrés** : `orders`, `payment`, `menus` (1 job/ancien client),
  `vendors` (1 job/admin) appellent `dispatcher.send(...)`. `user.listener` inchangé.
- **Bull Board** : `BullBoardModule.forRoot({ route: '/admin/queues', adapter:
  ExpressAdapter })` + `forFeature({ name: NOTIFICATIONS_QUEUE, adapter:
  BullMQAdapter })` + middleware Basic Auth sur `/admin/queues*`. Conditionné à
  Redis.

### Consommateur — `apps/worker`
- `WorkerModule` réécrit : `ConfigModule` (réutilise `envValidationSchema`,
  `REDIS_URL` requis côté worker), `PrismaModule`, `FirebaseModule`,
  `NotificationsModule` (via `@app/*`), `BullModule.forRootAsync`.
- **`NotificationsProcessor`** `@Processor(NOTIFICATIONS_QUEUE)` extends
  `WorkerHost` → `process(job)` appelle
  `notifications.sendPushNotification(job.data...)`. Retry/backoff portés par le
  job. Concurrency par défaut 5.
- `main.ts` garde un serveur HTTP minimal + `/health` (déployable en Render Web
  Service avec health-check).

### Env (`env.validation.ts`)
- `BULLBOARD_USER`, `BULLBOARD_PASSWORD` : optionnels (absents → dashboard off).
- `REDIS_URL` : optionnel pour lilia-app ; requis au boot du worker.

### Scripts / Render (`package.json`)
- `build:worker`: `nest build worker` · `start:worker:prod`: `node dist/apps/worker/main`.
- **Doc déploiement (étape dashboard manuelle, non automatisable ici)** : nouveau
  service Render (Web Service, même repo). Build :
  `npm install --include=dev && npx prisma generate && npm run build:worker`.
  Start : `node dist/apps/worker/main`. Env : `DATABASE_URL`, `FIREBASE_*`,
  `REDIS_URL`. Pas de `migrate deploy` côté worker (lilia-app possède les migrations).

## Tests (LIL-39)
- Unit `NotificationDispatcherService` : queue présente → `queue.add` appelé ;
  absente → `sendPushNotification` appelé.
- Unit `NotificationsProcessor.process` → délègue à `sendPushNotification` avec
  les bons args.
- Intégration chaîne : `emit('order.created')` → dispatcher enqueue (queue
  mockée) → job `push` ajouté avec le bon payload. FCM + Redis mockés ; vrai E2E
  Redis live hors CI.

## Non-objectifs
- **LIL-135 (outbox)** : garantie at-least-once (perte possible si lilia-app crash
  entre l'event et `queue.add`). Follow-up naturel, hors de ces 2 tickets.
- `user.listener` (email) non migré (FCM only).

## Découpage commits (1 commit/ticket, arbre complet)
- **LIL-38** : packages + alias `@app/*` + `NotificationQueueModule` + dispatcher
  + Bull Board + worker réécrit (processor) + migration `orders.listener` +
  scripts/doc Render.
- **LIL-39** : migration `payment`/`menus`/`vendors` + fallback finalisé + tests.

## Question ouverte (à trancher avant impl)
- 2 commits sur la branche `lil-38`, **ou** une branche par ticket (`lil-38` puis
  `lil-39`) ? (Gitbranch Linear : `hmipoka/lil-38-...` et `hmipoka/lil-39-...`.)
