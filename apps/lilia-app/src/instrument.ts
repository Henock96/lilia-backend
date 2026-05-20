/* eslint-disable prettier/prettier */
/**
 * Initialisation Sentry — DOIT être importé en TOUT PREMIER dans main.ts,
 * avant tout autre module, pour que l'auto-instrumentation patche les
 * librairies (http, pg, etc.) avant qu'elles ne soient chargées.
 *
 * Sentry reste totalement inactif si SENTRY_DSN n'est pas défini
 * (cas dev local sans compte Sentry) — aucun overhead, aucune erreur.
 *
 * Variables d'environnement (cf. .env.example) :
 *   SENTRY_DSN                   DSN du projet Sentry backend (vide = désactivé)
 *   SENTRY_ENVIRONMENT           dev | staging | production
 *   SENTRY_RELEASE               version/SHA du build (release tracking)
 *   SENTRY_TRACES_SAMPLE_RATE    fraction de requêtes tracées (def. 0.1)
 *   SENTRY_PROFILES_SAMPLE_RATE  fraction de traces profilées (def. 0.1)
 */
import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,

    // Performance tracing + profiling continu (instrumentation complète).
    // profileLifecycle 'trace' : le profiling démarre/s'arrête avec les traces.
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: parseFloat(
      process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1',
    ),
    profileLifecycle: 'trace',
    profileSessionSampleRate: parseFloat(
      process.env.SENTRY_PROFILES_SAMPLE_RATE ?? '0.1',
    ),

    // Logs structurés remontés à Sentry
    enableLogs: true,

    // On attache le contexte user explicitement (SentryUserInterceptor)
    // plutôt que d'envoyer IP/headers automatiquement.
    sendDefaultPii: false,

    // Les erreurs HTTP 4xx sont attendues (validation, not found, ...) :
    // ce ne sont pas des bugs, on ne les remonte pas pour éviter le bruit.
    beforeSend(event, hint) {
      const exception = hint?.originalException as
        | { getStatus?: () => number; status?: number }
        | undefined;
      const status =
        typeof exception?.getStatus === 'function'
          ? exception.getStatus()
          : exception?.status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return null;
      }
      return event;
    },
  });
}
