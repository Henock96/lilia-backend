/**
 * Résolution de la clé de comptage du rate limiting (fix C4 — audit 28/08/2026).
 *
 * `ThrottlerGuard` traçait par `req.ip`. Deux défauts cumulés :
 *
 *  1. sans `trust proxy` (ajouté dans `main.ts`), Express ignorait
 *     `X-Forwarded-For` derrière le load balancer Render et `req.ip` valait
 *     l'adresse du proxy — identique pour tout le monde. Le compteur devenait
 *     global par route : 10 `POST /orders/checkout` en une minute renvoyaient
 *     429 à toute la plateforme ;
 *  2. même avec `trust proxy` correct, le NAT des opérateurs congolais fait
 *     partager une IP publique à des milliers d'abonnés.
 *
 * On trace donc par **compte** dès qu'un jeton est présent.
 *
 * ⚠️ Le `sub` est lu **sans vérifier la signature** : à ce point de la chaîne,
 * `FirebaseAuthGuard` n'a pas encore tourné (les guards globaux d'`AppModule`
 * précèdent ceux d'`AuthModule`). C'est volontaire et sans conséquence de
 * sécurité : un `sub` forgé ne fait que déplacer le compteur de l'attaquant, il
 * ne lui donne aucun accès — la requête sera rejetée en 401 juste après — et il
 * ne peut pas saturer le compteur d'un autre utilisateur sans posséder son
 * jeton. On ne s'en sert jamais pour autoriser quoi que ce soit.
 */
import { resolveClientIp } from '../http/client-ip';

export function resolveThrottlerTracker(req: {
  headers?: Record<string, unknown>;
  firebaseUser?: { uid?: string };
  ips?: string[];
  ip?: string;
}): string {
  // Si un guard amont a déjà validé le jeton, on prend l'uid vérifié.
  const verifiedUid = req.firebaseUser?.uid;
  if (verifiedUid) return `uid:${verifiedUid}`;

  const claimedUid = extractSubject(req.headers?.authorization);
  if (claimedUid) return `uid:${claimedUid}`;

  // Routes publiques : on retombe sur l'IP réelle du client.
  //
  // ⚠️ Pas `req.ips[0]` : c'est l'entrée la plus à GAUCHE de `X-Forwarded-For`,
  // donc celle que le client contrôle — il lui suffisait d'en changer à chaque
  // requête pour ne jamais être compté. `resolveClientIp` prend
  // `CF-Connecting-IP`, que Cloudflare écrase et que l'appelant ne peut donc
  // pas choisir. Voir `common/http/client-ip.ts`.
  return `ip:${resolveClientIp(req) ?? 'unknown'}`;
}

function extractSubject(authorization: unknown): string | null {
  const header = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  if (typeof header !== 'string') return null;

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as { sub?: unknown; user_id?: unknown };

    const sub = payload.sub ?? payload.user_id;
    // Borne de longueur : la clé finit dans Redis, on ne laisse pas un client
    // choisir la taille de nos clés.
    return typeof sub === 'string' && sub.length > 0 && sub.length <= 128
      ? sub
      : null;
  } catch {
    return null;
  }
}
