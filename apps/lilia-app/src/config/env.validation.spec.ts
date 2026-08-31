import { envValidationSchema } from './env.validation';

/**
 * Garde-fous de démarrage.
 *
 * Le principe du fichier validé ici : **une dégradation silencieuse vaut moins
 * qu'un refus de démarrer bruyant**. Trois variables ont déjà été rendues
 * obligatoires pour cette raison (`REDIS_URL` en production,
 * `MTN_MOMO_WEBHOOK_SECRET` hors mode manuel, `ALLOWED_ORIGINS` en production) ;
 * ces tests verrouillent l'équivalent côté pawaPay.
 */
describe('envValidationSchema — mode PAWAPAY', () => {
  /** Le minimum pour franchir les `.required()` sans rapport avec le paiement. */
  const base = {
    DATABASE_URL: 'postgresql://user@localhost:5432/db',
    FIREBASE_PROJECT_ID: 'proj',
    FIREBASE_CLIENT_EMAIL: 'svc@proj.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY:
      '-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----',
    PAYMENT_MODE: 'PAWAPAY',
    PAWAPAY_API_URL: 'https://api.sandbox.pawapay.io',
    PAWAPAY_API_TOKEN: 'jeton',
  };

  const validate = (env: Record<string, unknown>) =>
    envValidationSchema.validate(env, { abortEarly: false });

  it('refuse de démarrer sans aucune authentification de callback', () => {
    // La configuration la plus dangereuse : tout démarre, l'argent rentre, et
    // chaque callback pawaPay repart en 401 sans que rien ne l'annonce.
    const { error } = validate(base);

    expect(error).toBeDefined();
    expect(error?.message).toContain('PAWAPAY_PUBLIC_KEY');
    expect(error?.message).toContain('PAWAPAY_CALLBACK_IPS');
  });

  it('accepte la signature seule (dispositif recommandé)', () => {
    const { error } = validate({
      ...base,
      PAWAPAY_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----x-----END PUBLIC KEY-----',
    });
    expect(error).toBeUndefined();
  });

  it('accepte la liste blanche seule (repli assumé)', () => {
    const { error } = validate({
      ...base,
      PAWAPAY_CALLBACK_IPS: '1.2.3.4,5.6.7.8',
    });
    expect(error).toBeUndefined();
  });

  it('une valeur vide ou blanche ne compte pas comme configurée', () => {
    // `PAWAPAY_PUBLIC_KEY=` dans un fichier d'environnement est le cas réel :
    // la variable existe, elle ne protège rien.
    const { error } = validate({
      ...base,
      PAWAPAY_PUBLIC_KEY: '   ',
      PAWAPAY_CALLBACK_IPS: '',
    });
    expect(error).toBeDefined();
  });

  it('exige jeton et URL du prestataire', () => {
    const { error } = validate({
      ...base,
      PAWAPAY_API_TOKEN: undefined,
      PAWAPAY_CALLBACK_IPS: '1.2.3.4',
    });
    expect(error?.message).toContain('PAWAPAY_API_TOKEN');
  });

  it('n’impose rien de tout cela en mode MANUAL', () => {
    // Le mode de repli doit rester démarrable sans la moindre variable pawaPay
    // — c'est son intérêt le jour où le prestataire tombe.
    const { error } = validate({
      DATABASE_URL: base.DATABASE_URL,
      FIREBASE_PROJECT_ID: base.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: base.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY: base.FIREBASE_PRIVATE_KEY,
      PAYMENT_MODE: 'MANUAL',
    });
    expect(error).toBeUndefined();
  });
});
