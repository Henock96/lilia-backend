import * as Joi from 'joi';

/**
 * Schéma de validation des variables d'environnement.
 *
 * Appliqué par `ConfigModule.forRoot({ validationSchema })` → le boot échoue
 * immédiatement (et explicitement) si une variable requise manque ou a un type
 * invalide, plutôt que de planter plus tard au premier appel runtime.
 *
 * Convention :
 *  - `.required()` : strictement nécessaire au fonctionnement (DB + Firebase).
 *  - le reste est optionnel (features dégradables) avec defaults raisonnables.
 */
export const envValidationSchema = Joi.object({
  // ─── Runtime ────────────────────────────────────────────────────────────
  NODE_ENV: Joi.string()
    .valid('development', 'staging', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(8080),
  // Nombre de proxys de confiance devant l'app (Render en place 1). Sert à
  // `app.set('trust proxy', n)` : sans ça, `req.ip` vaut l'IP du load balancer
  // et le rate limiting devient un compteur global (fix C4).
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(5).default(1),
  // Ce processus exécute-t-il les crons et le dépilage de l'outbox ?
  // `false` sur le service web quand le worker est déployé (cf.
  // `config/background-jobs.ts`). Défaut `true` : mieux vaut une redondance
  // — protégée par les verrous Redis — qu'une panne silencieuse.
  RUN_BACKGROUND_JOBS: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(true),
  WORKER_PORT: Joi.number().port().default(8081),
  // Rétention des positions GPS des courses terminées. La table grossit d'une
  // ligne par minute et par course ; 30 jours laissent le temps qu'un litige
  // remonte, sans conserver indéfiniment des traces de déplacement.
  TRACKING_RETENTION_DAYS: Joi.number().integer().min(1).max(365).default(30),

  // ─── Logs (nestjs-pino) ──────────────────────────────────────────────────
  // Niveau pino. Défaut résolu au runtime (info en prod, debug sinon).
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .optional(),

  // ─── Base de données (requis) ───────────────────────────────────────────
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),

  // ─── Firebase Admin SDK (requis) ──────────────────────────────────────────
  FIREBASE_PROJECT_ID: Joi.string().required(),
  FIREBASE_CLIENT_EMAIL: Joi.string().email().required(),
  FIREBASE_PRIVATE_KEY: Joi.string().required(),
  // `.allow('')` : une variable présente mais vide dans un .env doit être
  // traitée comme absente. Sans ça, `FIREBASE_SERVICE_ACCOUNT_PATH=` faisait
  // échouer le démarrage avec un message peu parlant.
  FIREBASE_SERVICE_ACCOUNT_PATH: Joi.string().allow('').optional(), // dev uniquement

  // ─── CORS — requis en production (cohérent avec le fail-fast de main.ts) ──
  ALLOWED_ORIGINS: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),

  // ─── Redis — REQUIS en production (fix M11) ───────────────────────────────
  // Sans Redis, trois contrôles se dégradent **en silence** :
  //  · idempotence du checkout désactivée (doubles commandes) ;
  //  · rate limiting en mémoire, donc par instance — la limite effective est
  //    multipliée par le nombre d'instances ;
  //  · verrous de cron inopérants (notifications vendeur en double) ;
  //  et le tracking WebSocket multi-instance ne fonctionne plus.
  // Un service de production qui démarre sans Redis démarre à moitié : on
  // préfère échouer au boot, comme pour ALLOWED_ORIGINS.
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),

  // ─── Cloudinary ───────────────────────────────────────────────────────────
  CLOUDINARY_CLOUD_NAME: Joi.string().allow('').optional(),
  CLOUDINARY_API_KEY: Joi.string().allow('').optional(),
  CLOUDINARY_API_SECRET: Joi.string().allow('').optional(),

  // ─── Paiements ──────────────────────────────────────────────────────────
  PAYMENT_MODE: Joi.string()
    .valid('MANUAL', 'SANDBOX', 'MTN_PRODUCTION')
    .default('MANUAL'),
  LILIA_PAYMENT_PHONE: Joi.string().allow('').optional(),
  // Numéro d'encaissement Airtel. Si absent, on retombe sur LILIA_PAYMENT_PHONE
  // (cf. PaymentService) — mais un client Airtel ne peut pas envoyer sur un
  // numéro MTN : à définir dès qu'Airtel Money est proposé au checkout.
  LILIA_AIRTEL_PAYMENT_PHONE: Joi.string().allow('').optional(),
  MTN_MOMO_API_KEY: Joi.string().optional(),
  MTN_MOMO_API_USER: Joi.string().optional(),

  // Dès qu'on quitte le mode MANUAL, MTN émet des callbacks signés. Le webhook
  // est fail-closed : sans secret configuré il rejette TOUT en 401, et aucun
  // paiement ne se confirme jamais — panne silencieuse le jour du go-live.
  // On préfère donc refuser de démarrer plutôt que de démarrer à moitié.
  MTN_MOMO_WEBHOOK_SECRET: Joi.string().when('PAYMENT_MODE', {
    is: Joi.valid('SANDBOX', 'MTN_PRODUCTION'),
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  // Attention : le code a un défaut `sandbox.momodeveloper.mtn.com`. En
  // MTN_PRODUCTION, oublier cette variable enverrait les paiements réels vers
  // le sandbox sans le moindre message d'erreur. D'où le `.required()`.
  MTN_MOMO_BASE_URL: Joi.string()
    .uri()
    .when('PAYMENT_MODE', {
      is: Joi.valid('SANDBOX', 'MTN_PRODUCTION'),
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
  MTN_MOMO_CALLBACK_URL: Joi.string().uri().optional(),
  MTN_MOMO_DISBURSEMENT_SUBSCRIPTION_KEY: Joi.string().optional(),
  MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY: Joi.string().when('PAYMENT_MODE', {
    is: Joi.valid('SANDBOX', 'MTN_PRODUCTION'),
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),

  // ─── Expiration des commandes impayées ────────────────────────────────────
  // Le stock est réservé au checkout : sans expiration il reste bloqué
  // indéfiniment sur une commande abandonnée (cf. OrderExpiryService).
  // Délai court = paiement jamais initié ; délai long = paiement en attente de
  // confirmation admin (le client a peut-être bien envoyé l'argent).
  ORDER_PAYMENT_TIMEOUT_MINUTES: Joi.number().integer().min(5).default(45),
  ORDER_PENDING_PAYMENT_TIMEOUT_MINUTES: Joi.number()
    .integer()
    .min(30)
    .default(360),

  // ─── Parrainage ───────────────────────────────────────────────────────────
  // Plafond de filleuls récompensés par parrain sur 30 jours glissants
  // (fix C3) : l'inscription Firebase est gratuite et illimitée, rien ne
  // corrèle deux comptes. 0 désactive le plafond.
  REFERRAL_MAX_REWARDS_PER_MONTH: Joi.number().integer().min(0).default(10),

  // ─── SMS Infobip ──────────────────────────────────────────────────────────
  INFOBIP_API_KEY: Joi.string().allow('').optional(),
  INFOBIP_BASE_URL: Joi.string().allow('').optional(),
  INFOBIP_SENDER: Joi.string().default('LiliaFood'),

  // ─── Email Resend ─────────────────────────────────────────────────────────
  // Optionnelles : sans elles le service se désactive proprement (les e-mails
  // sont ignorés, `sendEmail` renvoie `false`) plutôt que d'empêcher le
  // démarrage. En production, leur absence prive les vendeurs de leur lien
  // d'activation — l'API rend alors le lien à l'administrateur pour qu'il le
  // transmette lui-même.
  // ⚠️ `RESEND_SENDER_EMAIL` doit être sur un domaine vérifié dans Resend.
  RESEND_API_KEY: Joi.string().allow('').optional(),
  RESEND_SENDER_EMAIL: Joi.string().email().allow('').optional(),
  RESEND_SENDER_NAME: Joi.string().allow('').optional(),

  // ─── Sentry ───────────────────────────────────────────────────────────────
  SENTRY_DSN: Joi.string().uri().allow('').optional(),
})
  // tolère les variables non listées (PATH, etc.) sans les rejeter
  .unknown(true);
