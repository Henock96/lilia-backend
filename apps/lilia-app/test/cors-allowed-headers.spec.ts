import { CORS_ALLOWED_HEADERS } from '../src/common/http/cors-headers';

/**
 * Correspondance entre les en-têtes que le client web **envoie** et ceux que
 * le serveur **autorise**.
 *
 * ## Le défaut que cette suite empêche de revenir
 *
 * `packages/api-client/src/client.ts` ajoute `X-Lilia-Payment-Flow` à chaque
 * requête depuis le 31 août 2026. Le CORS du serveur, lui, n'autorisait que
 * `Content-Type,Authorization,Idempotency-Key`.
 *
 * Le symptôme est trompeur : le préflight répond `204` avec des en-têtes CORS
 * corrects — donc tout paraît sain côté serveur, et un `curl` fonctionne. Mais
 * le navigateur compare la requête réelle à `Access-Control-Allow-Headers`,
 * constate un en-tête non autorisé, et **n'émet jamais la requête**. `fetch`
 * rejette avec un `TypeError: Failed to fetch` sans détail.
 *
 * Résultat mesuré sur l'administration déployée le 4 septembre 2026 : plus
 * aucune donnée authentifiée dans les deux applications web. Tableau de bord
 * bloqué en squelettes, « Aucun vendeur » sur `/vendeurs`, aucune erreur
 * affichée. Le même appel joué sans cet en-tête renvoyait les six vendeurs.
 *
 * ⚠️ Ce test est volontairement écrit **à la main**, valeur par valeur. Le
 * dériver de la liste elle-même ne vérifierait que la capacité du code à
 * relire sa propre constante — le piège relevé sur la machine à états des
 * commandes en août 2026.
 */
describe('CORS — en-têtes autorisés', () => {
  const allowed = CORS_ALLOWED_HEADERS as readonly string[];

  it('autorise Content-Type et Authorization', () => {
    expect(allowed).toContain('Content-Type');
    expect(allowed).toContain('Authorization');
  });

  it('autorise Idempotency-Key — obligatoire sur POST /orders/checkout', () => {
    expect(allowed).toContain('Idempotency-Key');
  });

  it('autorise X-Lilia-Payment-Flow — envoyé par apiClient sur TOUTES les requêtes', () => {
    // Son absence ne casse pas le paiement : elle casse l'intégralité des
    // deux applications web, y compris les simples lectures.
    expect(allowed).toContain('X-Lilia-Payment-Flow');
  });

  it('la liste n’a ni doublon ni entrée vide', () => {
    expect(new Set(allowed).size).toBe(allowed.length);
    expect(allowed.every((h) => h.trim().length > 0)).toBe(true);
  });

  it('la sérialisation envoyée à enableCors ne porte aucune espace parasite', () => {
    // `allowedHeaders` est comparé par le navigateur après découpe sur la
    // virgule ; une espace mal placée invaliderait silencieusement une entrée.
    const serialized = allowed.join(',');
    expect(serialized).not.toMatch(/,\s/);
    expect(serialized.split(',')).toEqual([...allowed]);
  });

  it('autorise X-Lilia-Installation-Id — envoyé par apiClient sur TOUTES les requêtes', () => {
    const allowed = CORS_ALLOWED_HEADERS.map((h) => h.toLowerCase());

    // Signal anti-abus du parrainage, posé par `installationHeaders()` dans
    // `packages/api-client/src/client.ts` et par l'interceptor Dio côté
    // Flutter. L'omettre ici ne casserait pas l'inscription : le navigateur
    // refuserait d'émettre **toute** requête portant cet en-tête, donc les
    // deux applications web en entier — et en silence, le préflight répondant
    // 204 avec des en-têtes parfaitement corrects.
    expect(allowed).toContain('x-lilia-installation-id');
  });

  it('autorise X-Lilia-Platform', () => {
    const allowed = CORS_ALLOWED_HEADERS.map((h) => h.toLowerCase());
    expect(allowed).toContain('x-lilia-platform');
  });
});
