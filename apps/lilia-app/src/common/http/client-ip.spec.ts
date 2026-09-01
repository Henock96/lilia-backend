import { resolveClientIp } from './client-ip';

/**
 * Résolution de l'adresse client derrière Cloudflare + Render.
 *
 * Deux usages en dépendent, et les deux comptent :
 *  · la liste blanche d'IP du webhook pawaPay — se tromper d'adresse la rend
 *    soit inopérante, soit contournable ;
 *  · le rate limiting des routes publiques.
 *
 * Le cas réel observé en production :
 *
 * ```
 * X-Forwarded-For: 160.113.0.103, 162.158.42.108
 * CF-Connecting-IP: 160.113.0.103
 * ```
 *
 * Avec `TRUST_PROXY_HOPS=1`, `req.ip` valait `162.158.42.108` — un edge
 * Cloudflare, identique pour tous les clients.
 */
describe('resolveClientIp', () => {
  it('préfère CF-Connecting-IP à req.ip', () => {
    // Le cas de production : `req.ip` est l'edge Cloudflare, pas le client.
    expect(
      resolveClientIp({
        headers: { 'cf-connecting-ip': '160.113.0.103' },
        ip: '162.158.42.108',
      }),
    ).toBe('160.113.0.103');
  });

  it('retombe sur req.ip sans Cloudflare (local, tests, autre hébergeur)', () => {
    expect(resolveClientIp({ headers: {}, ip: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('ignore un en-tête vide ou blanc', () => {
    // Une valeur présente mais vide ne doit pas masquer `req.ip` : on
    // renverrait une chaîne vide, qui ne matcherait aucune liste blanche et
    // regrouperait tous les clients sous la même clé de comptage.
    expect(
      resolveClientIp({
        headers: { 'cf-connecting-ip': '   ' },
        ip: '1.2.3.4',
      }),
    ).toBe('1.2.3.4');
  });

  it('accepte un en-tête dupliqué en prenant la première valeur', () => {
    expect(
      resolveClientIp({
        headers: { 'cf-connecting-ip': ['10.0.0.1', '10.0.0.2'] },
        ip: '1.2.3.4',
      }),
    ).toBe('10.0.0.1');
  });

  it('rend undefined quand rien n’est exploitable', () => {
    expect(resolveClientIp({})).toBeUndefined();
  });

  it('⚠️ n’utilise JAMAIS X-Forwarded-For directement', () => {
    // C'est le cœur du sujet : `X-Forwarded-For` est fourni par l'appelant.
    // S'en servir laisserait forger l'adresse — donc contourner le rate
    // limiting, et surtout se faire passer pour pawaPay auprès de la liste
    // blanche du webhook.
    expect(
      resolveClientIp({
        headers: { 'x-forwarded-for': '3.64.89.224' },
        ip: '162.158.42.108',
      }),
    ).toBe('162.158.42.108');
  });
});
