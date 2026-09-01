/**
 * Adresse réelle du client, derrière la chaîne de proxys de production.
 *
 * ## Le problème
 *
 * L'application est servie par Render, lui-même derrière Cloudflare. Une
 * requête arrive donc avec :
 *
 * ```
 * X-Forwarded-For: <client réel>, <edge Cloudflare>
 * CF-Connecting-IP: <client réel>
 * socket: <interne Render>
 * ```
 *
 * `TRUST_PROXY_HOPS=1` ne fait confiance qu'à **un** saut : Express s'arrête sur
 * l'entrée la plus à droite de `X-Forwarded-For`, c'est-à-dire l'**edge
 * Cloudflare**. `req.ip` vaut donc une adresse de Cloudflare, la même pour tout
 * le monde — exactement le défaut que `trust proxy` était censé corriger.
 *
 * ## Pourquoi on ne passe PAS à `TRUST_PROXY_HOPS=2`
 *
 * Ce serait la correction évidente, et elle ouvrirait une faille. Express
 * compte les sauts **depuis la droite** en faisant confiance au contenu de
 * `X-Forwarded-For` — un en-tête que le client contrôle. Avec deux sauts de
 * confiance, un appelant qui envoie lui-même :
 *
 * ```
 * X-Forwarded-For: 3.64.89.224
 * ```
 *
 * verrait les proxys y ajouter les leurs, et `req.ip` retomberait sur la valeur
 * qu'il a choisie. Conséquences concrètes :
 *
 *  · il contournerait le rate limiting en changeant d'IP à chaque requête ;
 *  · surtout, il pourrait **se faire passer pour pawaPay** auprès de la liste
 *    blanche du webhook et fabriquer des confirmations de paiement.
 *
 * Le nombre de sauts reste donc à 1, et c'est cette fonction qui rétablit
 * l'adresse réelle.
 *
 * ## Pourquoi `CF-Connecting-IP` est digne de confiance ici
 *
 * Cloudflare **écrase** cet en-tête sur chaque requête entrante : une valeur
 * fournie par le client est remplacée, jamais conservée. Il n'est donc pas
 * falsifiable **tant que tout le trafic passe par Cloudflare** — ce qui est le
 * cas de l'edge de Render.
 *
 * ⚠️ Cette garantie disparaîtrait si l'application devenait joignable
 * directement, sans passer par l'edge. C'est pourquoi elle ne doit **jamais**
 * servir seule à authentifier quoi que ce soit : pour les callbacks pawaPay, la
 * signature RFC-9421 reste le dispositif de référence, insensible à la
 * topologie réseau. La liste blanche d'IP n'est qu'un repli.
 */
export function resolveClientIp(req: {
  headers?: Record<string, unknown>;
  ip?: string;
}): string | undefined {
  const cloudflare = firstHeaderValue(req.headers?.['cf-connecting-ip']);
  if (cloudflare) return cloudflare;

  // Pas de Cloudflare devant (développement local, tests, autre hébergeur) :
  // `req.ip` est déjà l'adresse réelle.
  return req.ip;
}

function firstHeaderValue(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
