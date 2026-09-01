import { resolveThrottlerTracker } from './throttler-tracker';

/**
 * Clé de comptage du rate limiting (fix C4 — audit du 28/08/2026).
 *
 * Le tracker était `req.ip`. Derrière le load balancer Render, et sans
 * `trust proxy`, cette valeur est **la même pour tous les clients** : le
 * compteur devenait global par route, et 10 `POST /orders/checkout` en une
 * minute renvoyaient 429 à toute la plateforme.
 */
describe('resolveThrottlerTracker (C4)', () => {
  /** Fabrique un JWT non signé — seul le payload compte ici. */
  function jwtWith(payload: Record<string, unknown>): string {
    const b64 = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${b64({ alg: 'RS256' })}.${b64(payload)}.signature`;
  }

  it("préfère l'uid vérifié quand un guard amont l'a déjà posé", () => {
    expect(
      resolveThrottlerTracker({
        firebaseUser: { uid: 'uid-verifie' },
        headers: { authorization: `Bearer ${jwtWith({ sub: 'autre' })}` },
        ip: '1.2.3.4',
      }),
    ).toBe('uid:uid-verifie');
  });

  it('retombe sur le `sub` du jeton — le ThrottlerGuard tourne AVANT FirebaseAuthGuard', () => {
    expect(
      resolveThrottlerTracker({
        headers: { authorization: `Bearer ${jwtWith({ sub: 'uid-abc' })}` },
        ip: '1.2.3.4',
      }),
    ).toBe('uid:uid-abc');
  });

  it('accepte `user_id` (claim Firebase historique)', () => {
    expect(
      resolveThrottlerTracker({
        headers: { authorization: `Bearer ${jwtWith({ user_id: 'uid-xyz' })}` },
      }),
    ).toBe('uid:uid-xyz');
  });

  it('deux comptes derrière la MÊME IP ont des compteurs distincts (NAT Brazzaville)', () => {
    const ip = '41.222.0.1';
    const a = resolveThrottlerTracker({
      headers: { authorization: `Bearer ${jwtWith({ sub: 'client-a' })}` },
      ip,
    });
    const b = resolveThrottlerTracker({
      headers: { authorization: `Bearer ${jwtWith({ sub: 'client-b' })}` },
      ip,
    });
    expect(a).not.toBe(b);
  });

  it("utilise l'IP réelle du client sur une route publique", () => {
    // Derrière Cloudflare, la seule adresse que l'appelant ne choisit pas.
    expect(
      resolveThrottlerTracker({
        headers: { 'cf-connecting-ip': '41.222.0.9' },
        ip: '162.158.42.108',
      }),
    ).toBe('ip:41.222.0.9');
  });

  it('sans Cloudflare, retombe sur req.ip', () => {
    expect(resolveThrottlerTracker({ ip: '41.222.0.9' })).toBe('ip:41.222.0.9');
  });

  it("⚠️ ne se laisse plus dicter l'IP par X-Forwarded-For", () => {
    // Ce test remplace une version qui lisait `req.ips[0]` — l'entrée la plus à
    // GAUCHE de `X-Forwarded-For`, donc fournie par l'appelant. Il suffisait
    // d'en changer à chaque requête pour n'être jamais compté. Le test
    // précédent verrouillait ce comportement en croyant vérifier « l'IP
    // réelle ».
    expect(
      resolveThrottlerTracker({
        headers: { 'x-forwarded-for': '1.1.1.1' },
        ips: ['1.1.1.1', '162.158.42.108'],
        ip: '162.158.42.108',
      }),
    ).toBe('ip:162.158.42.108');
  });

  it.each([
    ['en-tête absent', {}],
    ['schéma inattendu', { headers: { authorization: 'Basic abcdef' } }],
    ['jeton malformé', { headers: { authorization: 'Bearer pas-un-jwt' } }],
    ['payload non décodable', { headers: { authorization: 'Bearer a.@@@.c' } }],
    ['sub absent', { headers: { authorization: `Bearer ${'x'}` } }],
  ])('dégrade proprement sur l’IP : %s', (_label, req) => {
    expect(resolveThrottlerTracker({ ...req, ip: '9.9.9.9' })).toBe(
      'ip:9.9.9.9',
    );
  });

  it('borne la longueur du sub — la clé finit dans Redis', () => {
    const huge = 'a'.repeat(500);
    expect(
      resolveThrottlerTracker({
        headers: { authorization: `Bearer ${jwtWith({ sub: huge })}` },
        ip: '9.9.9.9',
      }),
    ).toBe('ip:9.9.9.9');
  });

  it('ne renvoie jamais une clé vide, même sans IP', () => {
    expect(resolveThrottlerTracker({})).toBe('ip:unknown');
  });
});
