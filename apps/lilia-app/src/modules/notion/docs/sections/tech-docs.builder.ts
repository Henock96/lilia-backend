import {
  bullets,
  callout,
  code,
  divider,
  h2,
  h3,
  numbered,
  p,
  table,
} from '../docs-block.helpers';
import { PageDef } from '../page-def.types';

/**
 * Section 1 — Documentation technique.
 * 10 pages couvrant les piliers d'architecture du système Lilia Food.
 */
export function buildTechDocsSection(): PageDef {
  return {
    title: '1. Documentation technique',
    icon: '🏗️',
    children: [
      callout(
        'Référence d\'architecture Lilia Food. Source canonique : ce wiki + le code dans lilia-backend / lilia-app / lilia-food-admin / lilia_food_delivery.',
        '📐',
      ),
      h2('Vue d\'ensemble'),
      p(
        'Lilia Food = plateforme de livraison de repas à Brazzaville (Congo). 4 surfaces : client mobile, livreur mobile, admin web, backend API.',
      ),
      h2('Pages de cette section'),
      ...bullets([
        'Backend Architecture (NestJS monorepo)',
        'Mobile App Architecture (Flutter + Riverpod)',
        'Admin Dashboard Architecture',
        'Database Architecture (Prisma + PostgreSQL)',
        'API Documentation (REST + conventions)',
        'Realtime System (Socket.io + Redis GEO)',
        'Authentication System (Firebase + Guards globaux)',
        'Notifications System (FCM)',
        'Payment System (MTN MoMo + Airtel Money)',
        'Deployment Infrastructure (Render + Docker)',
      ]),
    ],
    subPages: [
      backendArchitecture(),
      mobileAppArchitecture(),
      adminDashboardArchitecture(),
      databaseArchitecture(),
      apiDocumentation(),
      realtimeSystem(),
      authSystem(),
      notificationsSystem(),
      paymentSystem(),
      deploymentInfra(),
    ],
  };
}

function backendArchitecture(): PageDef {
  return {
    title: 'Backend Architecture',
    icon: '⚙️',
    children: [
      h2('Description'),
      p('API NestJS monorepo, expose toutes les opérations métier de Lilia Food. Build sur Render.'),
      h2('Stack'),
      ...bullets([
        'NestJS 11 (TypeScript strict)',
        'Prisma 7 + PostgreSQL (relationMode=prisma)',
        'Firebase Admin SDK (auth source de vérité)',
        'Redis (BullMQ, idempotency, tracking GEO, Socket.io adapter)',
        'Event-driven via @nestjs/event-emitter',
        'Cron via @nestjs/schedule',
      ]),
      h2('Structure des dossiers'),
      code(
`apps/lilia-app/src/
├── main.ts                  # Bootstrap + RedisIoAdapter + Swagger
├── app.module.ts            # Wire des modules + APP_GUARD ThrottlerGuard
├── common/                  # Adapters, filters, interceptors, pagination
├── prisma/                  # Service global singleton
└── modules/
    ├── auth/                # FirebaseAuthGuard + RolesGuard (APP_GUARD)
    ├── firebase/            # Admin SDK wrapper
    ├── users/               # Sync Firebase → DB
    ├── restaurants/, products/, categories/, menus/
    ├── cart/, orders/, deliveries/, payments/
    ├── tracking/            # WebSocket + Redis GEO
    ├── notifications/       # FCM push
    ├── notion/              # Sync vers Notion (BullMQ + bootstrap docs)
    ├── incidents/           # Tracker opérationnel
    ├── events/, listeners/  # Architecture événementielle
    └── schedule/            # Cron jobs`,
        'plain text',
      ),
      h2('Responsabilités par couche'),
      ...bullets([
        'Controllers : auth, validation DTO, formatage de réponse',
        'Services : règles métier, orchestration, événements',
        'Listeners : effets de bord (notifications, sync externe)',
        'Processors BullMQ : travail asynchrone (Notion, futurs exports)',
      ]),
      h2('Patterns clés'),
      ...bullets([
        'Guards globaux Firebase + Roles via APP_GUARD',
        'EventEmitter2 pour découpler les effets de bord (notif, sync, loyalty points)',
        'Idempotency Redis sur les routes critiques (checkout)',
        'Retry exponentiel sur intégrations externes (Notion, MTN MoMo)',
      ]),
      divider(),
      h3('Liens'),
      ...bullets([
        'Repo : lilia-backend/',
        'Prod : https://lilia-backend.onrender.com',
        'Swagger : /api-docs (désactivé en prod)',
      ]),
    ],
  };
}

function mobileAppArchitecture(): PageDef {
  return {
    title: 'Mobile App Architecture',
    icon: '📱',
    children: [
      h2('Apps Flutter'),
      ...bullets([
        'lilia-app — client final',
        'lilia_food_delivery — livreur (org com.dreesis)',
        'lilia-food-admin — admin Flutter',
      ]),
      h2('Stack'),
      ...bullets([
        'Flutter 3.41+',
        'Riverpod avec code generation (@riverpod)',
        'Firebase Auth (mêmes Firebase ID tokens que backend)',
        'Socket.io client pour le tracking temps réel',
      ]),
      h2('Feature-first architecture'),
      code(
`lib/features/<nom>/
├── data/         # repositories — appels HTTP, parsing JSON
├── application/  # controllers Riverpod @riverpod
├── presentation/ # screens + widgets
└── domain/       # entités locales si besoin`,
        'plain text',
      ),
      h2('Commandes Flutter clés'),
      code(
`flutter pub get
flutter run
dart run build_runner build --delete-conflicting-outputs   # après modif @riverpod`,
        'bash',
      ),
      callout(
        'Toujours wrapper les réponses API : json[\'data\'] côté Dart pour matcher l\'ApiResponseInterceptor backend.',
        '⚠️',
        'yellow_background',
      ),
    ],
  };
}

function adminDashboardArchitecture(): PageDef {
  return {
    title: 'Admin Dashboard Architecture',
    icon: '🖥️',
    children: [
      h2('Stack'),
      ...bullets([
        'Application Flutter (lilia-food-admin)',
        'Authentification Firebase rôle ADMIN obligatoire',
        'Tableaux de bord, gestion users, restaurants, paiements manuels',
      ]),
      h2('Responsabilités'),
      ...bullets([
        'Confirmation manuelle des paiements (mode MANUAL)',
        'Gestion incidents (créer, résoudre)',
        'Activation/désactivation restaurants',
        'Visualisation analytics (endpoints /dashboard/*)',
      ]),
    ],
  };
}

function databaseArchitecture(): PageDef {
  return {
    title: 'Database Architecture',
    icon: '🗄️',
    children: [
      h2('Provider'),
      p('PostgreSQL via Prisma ORM 7. relationMode = "prisma" — pas de FK natives, intégrité gérée applicativement.'),
      h2('Modèles principaux'),
      table(
        ['Modèle', 'Rôle'],
        [
          ['User', 'firebaseUid unique, role, loyaltyPoints, referralCode'],
          ['Restaurant', 'isOpen, manualOverride, operatingHours, ETA'],
          ['Product / ProductVariant', 'catalogue + stock quotidien'],
          ['Order', 'subTotal, deliveryFee, serviceFee 8%, total, status'],
          ['Delivery', 'orderId unique, delivererId, status, GPS'],
          ['Payment', 'amount, provider, status, providerTransactionId'],
          ['PromoCode / PromoUsage', 'FIXED / PERCENT / FREE_DELIVERY'],
          ['LoyaltyTransaction', 'points +/-, lié optionnellement à un Order'],
          ['Incident', 'OPS — annulations, accidents livreur, plaintes'],
        ],
      ),
      h2('Commandes Prisma'),
      code(
`npx prisma generate
npx prisma migrate dev --name <nom>
npx prisma migrate deploy
npx prisma studio`,
        'bash',
      ),
      callout(
        'Toute modif du schema → migration explicite (jamais db push en prod) + npx prisma generate.',
        '💾',
        'green_background',
      ),
    ],
  };
}

function apiDocumentation(): PageDef {
  return {
    title: 'API Documentation',
    icon: '🌐',
    children: [
      h2('Conventions globales'),
      ...bullets([
        'Header Authorization: Bearer <Firebase ID token> requis sauf @Public()',
        'Format réponse wrappée : { data: ... } ou { data: [...], count: N }',
        'Erreurs : { statusCode, message, error } — message en français',
        'Idempotency-Key sur POST /orders/checkout',
      ]),
      h2('Groupes d\'endpoints'),
      ...bullets([
        '/users — sync Firebase, profil, loyalty, parrainage',
        '/restaurants — CRUD, horaires, zones livraison',
        '/products /categories /menus — catalogue',
        '/cart — panier',
        '/orders — checkout, statuts, annulation, reorder',
        '/payments — MTN MoMo / Airtel + confirmation admin',
        '/deliveries — assignation, statuts, accept, position',
        '/tracking — position WebSocket + fallback HTTP',
        '/notifications — registre FCM token',
        '/promo — codes promo',
        '/incidents — OPS (ADMIN uniquement)',
        '/notion — bootstrap, sync, queue stats (ADMIN)',
      ]),
      h2('Décorateurs auth'),
      code(
`@Public()                       // bypass auth
@Roles('CLIENT', 'ADMIN')       // rôles autorisés
@FirebaseUser() user            // DecodedIdToken
@CurrentUser() user             // Prisma User (nécessite @Roles)`,
        'typescript',
      ),
    ],
  };
}

function realtimeSystem(): PageDef {
  return {
    title: 'Realtime System',
    icon: '📡',
    children: [
      h2('Stack'),
      ...bullets([
        'Socket.io namespace /tracking',
        'Auth via Firebase ID token dans handshake.auth.token',
        'Transports: websocket + polling (fallback Congo)',
        'Redis adapter pour multi-instance Render',
      ]),
      h2('Events'),
      table(
        ['Direction', 'Event', 'Payload'],
        [
          ['Client → Server', 'order:watch', '{ orderId }'],
          ['Livreur → Server', 'driver:position', '{ orderId, lat, lng, accuracy? }'],
          ['Server → Client', 'driver:position', '{ lat, lng, eta, timestamp }'],
          ['Server → Client', 'order:status', '{ status }'],
        ],
      ),
      h2('Persistance positions'),
      ...bullets([
        'Redis GEO `driver_positions` (lecture <1ms)',
        'Métadonnées `delivery:{orderId}` TTL 5min',
        'Persist DB max 1x/min via lock Redis (60s NX)',
        'ETA Haversine — 25 km/h Brazzaville',
      ]),
    ],
  };
}

function authSystem(): PageDef {
  return {
    title: 'Authentication System',
    icon: '🔐',
    children: [
      h2('Vue d\'ensemble'),
      p('Firebase Authentication est la source de vérité. Le backend valide les ID tokens via Firebase Admin SDK et synchronise un User Prisma par firebaseUid.'),
      h2('Flux'),
      ...numberedSteps([
        'Client login Firebase → ID token',
        'Client appelle POST /users/sync avec telephone, referralCode optionnels',
        'Backend upsert User Prisma + génère referralCode unique',
        'Toutes les requêtes suivantes incluent Authorization: Bearer <ID token>',
        'FirebaseAuthGuard (APP_GUARD) vérifie le token',
        'RolesGuard (APP_GUARD) charge le User Prisma si @Roles présent',
      ]),
      h2('Rôles'),
      ...bullets(['CLIENT', 'RESTAURATEUR', 'LIVREUR', 'ADMIN']),
      h2('Décorateurs'),
      code(
`@Public()                       // route publique
@Roles('LIVREUR')               // un seul rôle
@Roles('RESTAURATEUR', 'ADMIN') // plusieurs rôles
@FirebaseUser()                 // DecodedIdToken
@CurrentUser()                  // Prisma User`,
        'typescript',
      ),
      callout(
        'Sans @Roles(), @CurrentUser() ne fonctionne que sur /users/*. Toujours combiner.',
        '⚠️',
        'yellow_background',
      ),
    ],
  };
}

function notificationsSystem(): PageDef {
  return {
    title: 'Notifications System',
    icon: '🔔',
    children: [
      h2('Stack'),
      p('Firebase Cloud Messaging (FCM) uniquement. SSE retiré.'),
      h2('Endpoints'),
      ...bullets([
        'POST /notifications/register-token — body { token }',
        'DELETE /notifications/token — body { token }',
      ]),
      h2('Envoi'),
      code(
`await notificationsService.sendPushNotification(
  userId,
  'Titre',
  'Message',
  { orderId, type: 'order_update' },
);`,
        'typescript',
      ),
      ...bullets([
        'Envoi à tous les devices du user (FcmToken[])',
        'Nettoyage automatique des tokens invalides',
        'Android channelId high_importance_channel, priority high',
        'APNs contentAvailable, badge',
      ]),
    ],
  };
}

function paymentSystem(): PageDef {
  return {
    title: 'Payment System',
    icon: '💸',
    children: [
      h2('Modes'),
      table(
        ['Mode', 'Comportement'],
        [
          ['MANUAL', 'Client vire sur LILIA_PAYMENT_PHONE, admin confirme via POST /payments/:id/confirm'],
          ['SANDBOX', 'MTN MoMo sandbox — pour tests'],
          ['MTN_PRODUCTION', 'MTN MoMo live (agrément requis)'],
        ],
      ),
      h2('Flux'),
      ...numberedSteps([
        'Client paie via le moyen choisi (MTN_MOMO ou AIRTEL_MONEY)',
        'POST /payments crée un Payment PENDING',
        'Mode MANUAL : instructions de virement renvoyées',
        'Admin confirme → emit("order.payment.confirmed") → Order.status = PAYER',
        'Notifications client + restaurant via PaymentListener',
      ]),
      h2('Variables env'),
      code(
`PAYMENT_MODE=MANUAL
LILIA_PAYMENT_PHONE=+242XXXXXXXXX
MTN_MOMO_API_KEY=...
MTN_MOMO_API_USER=...`,
        'bash',
      ),
    ],
  };
}

function deploymentInfra(): PageDef {
  return {
    title: 'Deployment Infrastructure',
    icon: '🚀',
    children: [
      h2('Plateforme'),
      ...bullets([
        'Backend : Render (web service)',
        'PostgreSQL : managé Render',
        'Redis : Render (BullMQ + tracking + idempotency)',
        'Apps mobiles : Play Store / App Store (futur)',
      ]),
      h2('Build & start'),
      code(
`# Render build
npm run render-build
# = npm install --include=dev && prisma generate && prisma migrate deploy && npm run build
# Start
node dist/apps/lilia-app/main`,
        'bash',
      ),
      h2('Variables d\'environnement clés'),
      ...bullets([
        'DATABASE_URL, REDIS_URL',
        'FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY',
        'PAYMENT_MODE, LILIA_PAYMENT_PHONE',
        'NOTION_TOKEN, NOTION_WORKSPACE_PAGE_ID, NOTION_DB_*',
        'CLOUDINARY_*, MAILTRAP_*, AFRICAS_TALKING_*',
      ]),
      callout(
        'Ne jamais committer .env. Toujours utiliser .env.example comme référence et configurer via le dashboard Render.',
        '🔒',
        'red_background',
      ),
    ],
  };
}

function numberedSteps(items: string[]) {
  return items.map(numbered);
}
