import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { envValidationSchema } from './env.validation';

/**
 * `.env.example` doit décrire **toutes** les variables que le code lit.
 *
 * ## Pourquoi ce test existe
 *
 * Le fichier documentait `PAYMENT_MODE=MANUAL`, MTN MoMo et une époque révolue,
 * et ne mentionnait **aucune** des sept variables pawaPay — ni `ALLOWED_ORIGINS`,
 * ni `SENTRY_DSN`, ni les trois délais d'expiration de commande, ni dix autres.
 * Vingt-cinq au total.
 *
 * Quelqu'un provisionnant un environnement à partir de ce fichier obtenait donc
 * un backend qui **ne peut pas encaisser**, et rien ne lui disait ce qui
 * manquait : le schéma Joi ne se plaint que de ce qui est `.required()`, et
 * l'essentiel de la configuration de paiement est conditionnel.
 *
 * ## Pourquoi un test et pas seulement une mise à jour du fichier
 *
 * Parce qu'il avait déjà été à jour, un jour. Un fichier d'exemple dérive à
 * chaque variable ajoutée, silencieusement, et personne ne s'en aperçoit avant
 * le prochain déploiement depuis zéro — c'est-à-dire au pire moment.
 *
 * Même dispositif que `cors-allowed-headers.spec.ts`, qui fige la
 * correspondance entre la liste blanche CORS et les en-têtes du client : une
 * correspondance entre deux fichiers ne tient que si quelque chose la vérifie.
 */
describe('.env.example ↔ schéma de validation', () => {
  /** Les clés déclarées dans le schéma Joi — la spécification qui fait foi. */
  const schemaKeys = Object.keys(envValidationSchema.describe().keys ?? {});

  /** Les clés documentées dans `.env.example`, commentaires exclus. */
  const exampleKeys = (() => {
    const raw = readFileSync(
      join(__dirname, '../../../../.env.example'),
      'utf8',
    );
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split('=')[0].trim())
      .filter(Boolean);
  })();

  it('documente toutes les variables lues par le code', () => {
    const missing = schemaKeys.filter((k) => !exampleKeys.includes(k)).sort();

    // Message explicite : on veut lire QUELLES variables manquent, pas un
    // `expect(25).toBe(0)`.
    expect({ manquantes: missing }).toEqual({ manquantes: [] });
  });

  it('ne documente aucune variable que le code ne lit plus', () => {
    // L'inverse compte autant : une variable fantôme dans l'exemple se retrouve
    // posée en production, où elle ne fait rien — et fait croire que le réglage
    // est en place. `SMS_SENDER_ID` a vécu ainsi à côté d'`INFOBIP_SENDER`.
    const orphaned = exampleKeys.filter((k) => !schemaKeys.includes(k)).sort();

    expect({ orphelines: orphaned }).toEqual({ orphelines: [] });
  });

  it('ne contient aucune valeur qui ressemble à un vrai secret', () => {
    const raw = readFileSync(
      join(__dirname, '../../../../.env.example'),
      'utf8',
    );

    // Le fichier est versionné, et le dépôt est public. Un exemple ne porte que
    // des gabarits.
    expect(raw).not.toMatch(/\bre_[A-Za-z0-9]{20,}/); // clé Resend
    expect(raw).not.toMatch(/\bsk_live_/); // clé secrète de paiement
    expect(raw).not.toMatch(/-----BEGIN (RSA )?PRIVATE KEY-----\s*\n?\s*M/); // vraie clé
  });
});
