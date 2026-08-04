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
  FIREBASE_SERVICE_ACCOUNT_PATH: Joi.string().optional(), // dev uniquement

  // ─── CORS — requis en production (cohérent avec le fail-fast de main.ts) ──
  ALLOWED_ORIGINS: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),

  // ─── Redis / WebSocket / idempotency (optionnel — dégradé si absent) ──────
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .optional(),

  // ─── Cloudinary ───────────────────────────────────────────────────────────
  CLOUDINARY_CLOUD_NAME: Joi.string().optional(),
  CLOUDINARY_API_KEY: Joi.string().optional(),
  CLOUDINARY_API_SECRET: Joi.string().optional(),

  // ─── Paiements ──────────────────────────────────────────────────────────
  PAYMENT_MODE: Joi.string()
    .valid('MANUAL', 'SANDBOX', 'MTN_PRODUCTION')
    .default('MANUAL'),
  LILIA_PAYMENT_PHONE: Joi.string().optional(),
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

  // ─── SMS Infobip ──────────────────────────────────────────────────────────
  INFOBIP_API_KEY: Joi.string().optional(),
  INFOBIP_BASE_URL: Joi.string().optional(),
  INFOBIP_SENDER: Joi.string().default('LiliaFood'),

  // ─── Email Mailtrap ───────────────────────────────────────────────────────
  MAILTRAP_API_TOKEN: Joi.string().optional(),
  MAILTRAP_SENDER_EMAIL: Joi.string().email().optional(),
  MAILTRAP_SENDER_NAME: Joi.string().optional(),

  // ─── Sentry ───────────────────────────────────────────────────────────────
  SENTRY_DSN: Joi.string().uri().optional(),
})
  // tolère les variables non listées (PATH, etc.) sans les rejeter
  .unknown(true);
