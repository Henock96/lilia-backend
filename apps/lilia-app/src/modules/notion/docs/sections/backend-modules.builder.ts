import {
  bullets,
  callout,
  code,
  divider,
  h2,
  h3,
  p,
} from '../docs-block.helpers';
import { PageDef } from '../page-def.types';

/**
 * Section 2 — Documentation par module backend.
 *
 * Catalogue centralisé : une seule source de vérité, un seul template
 * pour générer N pages cohérentes. Pour ajouter un module → ajouter
 * une entrée dans MODULE_CATALOG.
 */
interface ModuleDocSpec {
  title: string;
  icon: string;
  description: string;
  responsibilities: string[];
  controllers?: string[];
  services?: string[];
  dtos?: string[];
  events?: string[];
  queues?: string[];
  prismaModels?: string[];
  notes?: string[];
}

const MODULE_CATALOG: ModuleDocSpec[] = [
  {
    title: 'auth',
    icon: '🔐',
    description:
      'Vérifie les Firebase ID tokens et applique RolesGuard. Enregistre 2 APP_GUARD globaux.',
    responsibilities: [
      'FirebaseAuthGuard — valide Authorization: Bearer <ID token>',
      'RolesGuard — charge le User Prisma et vérifie @Roles',
      'Décorateurs @Public, @Roles, @FirebaseUser, @CurrentUser',
    ],
    services: ['FirebaseAuthGuard', 'RolesGuard'],
    notes: [
      'APP_GUARD = tous les endpoints protégés par défaut',
      '@CurrentUser() sans @Roles ne fonctionne que sur /users/*',
    ],
  },
  {
    title: 'users',
    icon: '👤',
    description:
      'Pont entre Firebase Auth et la base Prisma. Génère referralCode, gère loyaltyPoints.',
    responsibilities: [
      'Sync Firebase Auth → User Prisma',
      'Gestion parrainage (referralCode unique, +500 pts au parrain à la 1ère commande)',
      'Loyalty points (1 pt / 100 XAF gagnés, 100 pts min pour utiliser)',
    ],
    controllers: ['POST /users/sync', 'GET /users/me', 'PUT /users/me', 'GET /users/me/referral-stats', 'GET /users/me/loyalty'],
    services: ['UsersService'],
    events: ['user.created → UserListener: email Mailtrap'],
    prismaModels: ['User', 'LoyaltyTransaction'],
  },
  {
    title: 'restaurants',
    icon: '🏪',
    description:
      'CRUD restaurants + horaires d\'ouverture + zones de livraison.',
    responsibilities: [
      'CRUD owner-scoped pour les RESTAURATEUR',
      'Auto open/close via OperatingHours (cron chaque minute)',
      'Override manuel (manualOverride)',
      'Mode prix livraison FIXED ou ZONE_BASED',
    ],
    controllers: ['GET /restaurants', 'GET /restaurants/:id', 'POST /restaurants', 'PATCH /restaurants/:id'],
    services: ['RestaurantsService'],
    prismaModels: ['Restaurant', 'OperatingHours', 'Specialty', 'DeliveryZone'],
  },
  {
    title: 'orders',
    icon: '🧾',
    description:
      'Commandes : state machine, idempotency, calculs, intégration promo + loyalty.',
    responsibilities: [
      'Checkout idempotent (header idempotency-key, cache Redis 1h)',
      'OrderValidator : user, cart, même resto, adresse, stock, resto ouvert',
      'OrderCalculator : subTotal + deliveryFee + serviceFee (8%) - discount',
      'OrderStateMachine : EN_ATTENTE → PAYER → EN_PREPARATION → PRET → EN_ROUTE → LIVRER',
      'Annulation client (EN_ATTENTE), soft delete (deleteCommande)',
    ],
    controllers: [
      'POST /orders/checkout',
      'GET /orders/my',
      'GET /orders/restaurant',
      'PATCH /orders/:id/status',
      'PATCH /orders/:id/cancel',
      'POST /orders/:id/reorder',
    ],
    services: ['OrdersService', 'OrderValidator', 'OrderCalculator', 'OrderStateMachine'],
    events: ['order.created', 'order.status.updated', 'order.cancelled', 'order.payment.confirmed'],
    prismaModels: ['Order', 'OrderItem', 'OrderHistory'],
  },
  {
    title: 'deliveries (riders)',
    icon: '🛵',
    description: 'Assignation livreur, statuts, accept, position fallback HTTP.',
    responsibilities: [
      'Liste des livreurs disponibles (DriverStatus.AVAILABLE)',
      'Assignation depuis le restaurateur',
      'Accept livreur → state machine EN_ROUTE',
      'Mise à jour position (fallback HTTP vers le module tracking)',
    ],
    controllers: [
      'GET /deliveries/restaurant',
      'GET /deliveries/mine',
      'GET /deliveries/my-missions',
      'GET /deliveries/by-order/:orderId',
      'PATCH /deliveries/by-order/:orderId/assign',
      'PATCH /deliveries/:id/accept',
      'PATCH /deliveries/:id/status',
      'PATCH /deliveries/:id/location',
    ],
    services: ['DeliveriesService'],
    prismaModels: ['Delivery', 'DeliveryLocation'],
  },
  {
    title: 'payments',
    icon: '💸',
    description:
      'MTN MoMo + Airtel Money + mode MANUAL (virement → admin confirme).',
    responsibilities: [
      'Création Payment lié à un Order',
      'Mode MANUAL : instructions de virement renvoyées',
      'Mode SANDBOX/MTN_PRODUCTION : requestToPay MTN MoMo',
      'Webhook callback MTN → checkPaymentStatus',
    ],
    controllers: [
      'POST /payments',
      'GET /payments/:paymentId/status',
      'POST /payments/:paymentId/confirm (ADMIN, mode MANUAL)',
    ],
    services: ['PaymentService'],
    events: ['order.payment.confirmed', 'order.payment.failed', 'order.payment.timeout'],
    prismaModels: ['Payment'],
  },
  {
    title: 'notifications',
    icon: '🔔',
    description: 'Push notifications FCM, gestion des tokens device.',
    responsibilities: [
      'Enregistrement/suppression de tokens FCM par user',
      'Envoi à tous les devices du user',
      'Nettoyage tokens invalides (messaging/invalid-registration-token)',
    ],
    controllers: ['POST /notifications/register-token', 'DELETE /notifications/token'],
    services: ['NotificationsService'],
    prismaModels: ['FcmToken'],
  },
  {
    title: 'tracking',
    icon: '📡',
    description:
      'WebSocket Socket.io /tracking + Redis GEO + ETA Haversine.',
    responsibilities: [
      'Gateway Socket.io avec auth Firebase token',
      'Redis GEO pour lecture <1ms des positions',
      'Persist DB max 1x/min via lock Redis',
      'ETA temps réel 25 km/h Brazzaville',
      'HTTP fallback POST /tracking/position',
    ],
    controllers: ['POST /tracking/position', 'POST /tracking/position/batch'],
    services: ['TrackingService', 'TrackingGateway'],
    notes: [
      'Multi-instance via RedisIoAdapter (REDIS_URL requis)',
      'Polling fallback pour connexions Congo instables',
    ],
  },
  {
    title: 'incidents (support)',
    icon: '🚨',
    description:
      'Tracker opérationnel : annulations, retards, accidents livreur, plaintes.',
    responsibilities: [
      'CRUD ADMIN-only',
      'Listener qui crée auto un Incident à order.cancelled',
      'Sync vers Notion via NotionListener',
    ],
    controllers: [
      'POST /incidents',
      'GET /incidents?status&severity&type',
      'GET /incidents/:id',
      'PATCH /incidents/:id',
    ],
    services: ['IncidentsService', 'IncidentsListener'],
    events: ['incident.created', 'incident.updated'],
    prismaModels: ['Incident'],
  },
  {
    title: 'reviews',
    icon: '⭐',
    description: 'Notes 1-5 par client, liées optionnellement à une commande.',
    responsibilities: [
      'CRUD reviews scoped restaurant',
      'Agrégation averageRating + totalReviews côté Restaurant',
    ],
    services: ['ReviewsService'],
    prismaModels: ['Review'],
  },
  {
    title: 'admin',
    icon: '🛠️',
    description: 'Endpoints réservés ADMIN : créer resto, gérer users.',
    responsibilities: [
      'Création restaurants avec attribution d\'un owner User',
      'Activation/désactivation user (StatusUser)',
    ],
    services: ['AdminService'],
  },
  {
    title: 'dashboard (analytics)',
    icon: '📊',
    description: '7 endpoints d\'analytics pour l\'admin web.',
    responsibilities: [
      'Stats globales (commandes, revenus, croissance)',
      'Top restaurants / livreurs',
      'Comptages par statut, par jour',
    ],
    controllers: ['GET /dashboard/* (7 endpoints)'],
    services: ['DashboardService'],
    notes: ['Réponses non-wrappées (objets plats, pas { data })'],
  },
  {
    title: 'promo (coupons)',
    icon: '🎟️',
    description: 'Codes promo FIXED / PERCENT / FREE_DELIVERY.',
    responsibilities: [
      'Validation côté client avant checkout',
      'Application atomique en transaction dans le checkout',
      'Limites : maxUsageTotal, maxUsagePerUser, firstOrderOnly',
      'Possibilité de scoper par restaurantId',
    ],
    controllers: [
      'POST /promo/validate',
      'POST /promo (ADMIN)',
      'GET /promo (ADMIN)',
      'PATCH /promo/:id/toggle',
      'GET /promo/:id/stats',
    ],
    services: ['PromoService'],
    prismaModels: ['PromoCode', 'PromoUsage'],
  },
  {
    title: 'notion',
    icon: '📓',
    description:
      'Intégration Notion : sync event-driven (BullMQ) + bootstrap de la documentation.',
    responsibilities: [
      'Listener EventEmitter2 → enqueue jobs BullMQ',
      'Sync orders / restaurants / incidents vers Notion databases',
      'Bootstrap structure : page racine + 3 DBs + 8 sections doc',
      'Retry exponentiel + rate limit 3 req/s',
    ],
    controllers: [
      'POST /notion/bootstrap (ADMIN)',
      'POST /notion/docs/bootstrap (ADMIN)',
      'POST /notion/sync/order/:id (ADMIN)',
      'POST /notion/backfill (ADMIN)',
      'GET /notion/health',
      'GET /notion/queue/stats',
    ],
    services: [
      'NotionService (façade)',
      'NotionClient (retry + rate limit)',
      'OrdersSyncService, RestaurantsSyncService, IncidentsSyncService',
      'NotionBootstrapService, DocsBootstrapService',
      'NotionSyncProcessor (worker BullMQ)',
      'NotionListener',
    ],
    queues: ['notion-sync (concurrency 2, 5 attempts, backoff exponentiel)'],
  },
];

export function buildBackendModulesSection(): PageDef {
  return {
    title: '2. Backend modules',
    icon: '🧩',
    children: [
      callout(
        `${MODULE_CATALOG.length} modules NestJS documentés. Source : code dans apps/lilia-app/src/modules/.`,
        '🧩',
      ),
      h2('Catalogue'),
      ...bullets(MODULE_CATALOG.map((m) => `${m.icon} ${m.title} — ${m.description}`)),
    ],
    subPages: MODULE_CATALOG.map(moduleSpecToPage),
  };
}

function moduleSpecToPage(spec: ModuleDocSpec): PageDef {
  const children = [
    p(spec.description),
    h2('Responsabilités'),
    ...bullets(spec.responsibilities),
  ];

  if (spec.controllers?.length) {
    children.push(h3('Endpoints / Controllers'));
    children.push(...bullets(spec.controllers));
  }
  if (spec.services?.length) {
    children.push(h3('Services'));
    children.push(...bullets(spec.services));
  }
  if (spec.dtos?.length) {
    children.push(h3('DTOs'));
    children.push(...bullets(spec.dtos));
  }
  if (spec.events?.length) {
    children.push(h3('Events émis / écoutés'));
    children.push(...bullets(spec.events));
  }
  if (spec.queues?.length) {
    children.push(h3('Queues BullMQ'));
    children.push(...bullets(spec.queues));
  }
  if (spec.prismaModels?.length) {
    children.push(h3('Modèles Prisma'));
    children.push(...bullets(spec.prismaModels));
  }
  if (spec.notes?.length) {
    children.push(divider());
    children.push(h3('Notes'));
    children.push(...bullets(spec.notes));
  }

  return {
    title: `Module: ${spec.title}`,
    icon: spec.icon,
    children,
  };
}
