import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { envValidationSchema } from './env.validation';

/**
 * `.env.example` doit **démarrer**, pas seulement lister les bonnes clés.
 *
 * ## Le trou que ce test ferme
 *
 * `env-example-parity.spec.ts` compare les **noms** de variables entre le
 * schéma et le fichier d'exemple. Il est aveugle à leurs **valeurs** : un
 * gabarit que Joi refuse passe le test de parité et fait pourtant échouer le
 * boot.
 *
 * C'est arrivé le 22/09/2026, en ajoutant les délais Redis et les taux
 * d'échantillonnage Sentry. Ils étaient documentés « vides = valeur par défaut
 * du code » — une intention juste — mais `Joi.number()` refuse la chaîne vide :
 *
 * ```
 * Error: Config validation error: "REDIS_COMMAND_TIMEOUT_MS" must be a number
 * ```
 *
 * Or copier `.env.example` en `.env` est **la** façon documentée de provisionner
 * un environnement. Le fichier censé faire démarrer un backend l'en aurait
 * empêché — et le test de parité, vert, aurait confirmé que tout allait bien.
 *
 * ## Ce que ce test exerce
 *
 * Exactement ce que fait `ConfigModule` au démarrage : le schéma complet contre
 * les valeurs du fichier. Il couvre donc aussi les règles croisées (comme
 * l'exigence d'une authentification de callback en mode PAWAPAY).
 */
describe('.env.example — les valeurs documentées démarrent', () => {
  /** Parse le fichier comme le ferait `dotenv` : clé, `=`, reste de la ligne. */
  const documented: Record<string, string> = (() => {
    const raw = readFileSync(
      join(__dirname, '../../../../.env.example'),
      'utf8',
    );
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      // Les commentaires de fin de ligne ne font pas partie de la valeur.
      out[trimmed.slice(0, eq).trim()] = trimmed
        .slice(eq + 1)
        .split('#')[0]
        .trim();
    }
    return out;
  })();

  it('valide sans erreur (c’est ce que fait ConfigModule au boot)', () => {
    const { error } = envValidationSchema.validate(documented, {
      abortEarly: false,
      allowUnknown: true,
    });

    // Message explicite : on veut lire QUELLE valeur ne passe pas, pas un
    // booléen. `''` sur un `Joi.number()` est le piège le plus facile à poser.
    expect(error?.details.map((d) => d.message) ?? []).toEqual([]);
  });

  it('inspecte réellement un fichier peuplé (garde anti-balayage vide)', () => {
    // Sans cette garde, un chemin erroné rendrait le test précédent vert pour
    // la pire des raisons : il n'aurait rien validé.
    expect(Object.keys(documented).length).toBeGreaterThan(30);
    expect(documented).toHaveProperty('DATABASE_URL');
  });

  it('laisse une variable numérique vide signifier « valeur par défaut »', () => {
    // L'intention documentée dans le fichier : `REDIS_COMMAND_TIMEOUT_MS=`
    // veut dire « je ne surcharge pas », pas « zéro ». Le schéma doit le dire
    // aussi, sinon les deux se contredisent en silence jusqu'au boot.
    const { error, value } = envValidationSchema.validate(
      { ...documented, REDIS_COMMAND_TIMEOUT_MS: '' },
      { abortEarly: false, allowUnknown: true },
    );

    expect(error).toBeUndefined();
    expect(value.REDIS_COMMAND_TIMEOUT_MS).toBeUndefined();
  });

  /**
   * `.empty('')` ne doit relâcher **aucune** exigence conditionnelle.
   *
   * C'est le point qui mérite un test permanent : `PAWAPAY_API_TOKEN` est
   * `.required()` en mode PAWAPAY — sans lui, aucun encaissement ne part, et
   * la panne n'apparaît qu'au premier client. Une ligne laissée vide dans un
   * `.env` ne doit jamais passer pour une valeur fournie : le boot accepterait
   * une configuration qui ne peut pas encaisser.
   *
   * (Ce test visait `MTN_MOMO_WEBHOOK_SECRET` jusqu'au retrait du rail MTN
   * direct, le 19/11/2026.)
   */
  describe("`.empty('')` ne relâche pas les exigences conditionnelles", () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
      FIREBASE_PROJECT_ID: 'p',
      FIREBASE_CLIENT_EMAIL: 'a@b.co',
      FIREBASE_PRIVATE_KEY: 'k',
      PAWAPAY_API_URL: 'https://api.sandbox.pawapay.io',
      PAWAPAY_CALLBACK_IPS: '1.2.3.4',
    };

    function messagesFor(env: Record<string, string>): string[] {
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
        allowUnknown: true,
      });
      return error?.details.map((d) => d.message) ?? [];
    }

    it('refuse un jeton pawaPay VIDE en mode PAWAPAY', () => {
      const messages = messagesFor({
        ...base,
        PAYMENT_MODE: 'PAWAPAY',
        PAWAPAY_API_TOKEN: '',
      });

      expect(messages.join(' | ')).toContain('PAWAPAY_API_TOKEN');
    });

    it('refuse un jeton pawaPay ABSENT en mode PAWAPAY', () => {
      const messages = messagesFor({ ...base, PAYMENT_MODE: 'PAWAPAY' });

      expect(messages.join(' | ')).toContain('PAWAPAY_API_TOKEN');
    });

    it('accepte un jeton réellement posé', () => {
      const messages = messagesFor({
        ...base,
        PAYMENT_MODE: 'PAWAPAY',
        PAWAPAY_API_TOKEN: 'jeton',
      });

      expect(messages).toEqual([]);
    });

    it('tolère un jeton vide en mode MANUAL, où il ne sert pas', () => {
      const messages = messagesFor({
        ...base,
        PAYMENT_MODE: 'MANUAL',
        PAWAPAY_API_TOKEN: '',
      });

      expect(messages).toEqual([]);
    });

    it('refuse les anciens modes du rail MTN direct', () => {
      for (const mode of ['SANDBOX', 'MTN_PRODUCTION']) {
        const messages = messagesFor({ ...base, PAYMENT_MODE: mode });
        expect(messages.join(' | ')).toContain('PAYMENT_MODE');
      }
    });
  });

  it('refuse toujours une valeur numérique aberrante', () => {
    // Tolérer le vide ne doit pas revenir à tout tolérer : un délai de 1 ms
    // ferait échouer chaque commande Redis (RTT réel ≈ 395 ms).
    const { error } = envValidationSchema.validate(
      { ...documented, REDIS_COMMAND_TIMEOUT_MS: '1' },
      { abortEarly: false, allowUnknown: true },
    );

    expect(error).toBeDefined();
  });
});
