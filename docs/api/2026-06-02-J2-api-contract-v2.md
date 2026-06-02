# API Contract v2 — Uniformisation des réponses (J2 Coherence Sprint)

**Date** : 2026-06-02
**Branche** : `hmipoka/api-contract-v2`
**Référence audit** : Linear doc `5baaff6e47d3`
**Statut** : opt-in côté clients pendant la transition, par défaut côté backend.

---

## Contexte

L'audit a relevé des shapes de réponse incohérentes entre endpoints :

| Endpoint | Shape avant |
|----------|-------------|
| `GET /restaurants` | `{ data: [...], count }` |
| `GET /restaurants/:id` | `{ data: {...} }` |
| `GET /users/me` | `{ user: {...} }` |
| `POST /promo/validate` | objet plat (`{ discountAmount, newDeliveryFee, ... }`) |
| `GET /dashboard/*` | objet plat |
| `GET /deliveries/my-missions` | tableau brut |
| `GET /deliveries/mine` | `{ data: [...], count }` |

Conséquences : les clients Flutter ont crashé avec
`List<dynamic> is not a subtype of Map<String, dynamic>` parce que le code
faisait `decoded['data']` sans savoir si la réponse était wrappée.

---

## Décision

Toutes les réponses HTTP du backend sont désormais enveloppées par défaut via
un intercepteur **global** dans le format suivant :

```json
{
  "data": <payload>,
  "message"?: string,
  "meta"?: object
}
```

Seules ces trois clés sont autorisées au niveau racine.

### Implémentation

- Fichier : `apps/lilia-app/src/common/interceptors/api-response.interceptor.ts`
- Enregistré globalement dans `app.module.ts` via `APP_INTERCEPTOR`
- Décorateur d'opt-out : `@SkipResponseWrap()` exporté depuis le même fichier

### Règles précises

1. `undefined` / `null` → `{ "data": null }`
2. `StreamableFile` → passthrough (ne JAMAIS wrapper un binaire)
3. `@SkipResponseWrap()` (méthode ou controller) → passthrough
4. Objet `{ data, message?, meta? }` strict (aucune autre clé) → passthrough
5. Tout le reste (array brut, objet, primitive) → wrappé en `{ data: ... }`

⚠️ Conséquence importante :

- `{ data, count }` devient `{ data: { data, count } }` après l'intercepteur.
  Les endpoints qui exposaient `count`, `total`, `page`, `limit` à la racine
  doivent **migrer ces clés sous `meta`**. Tracking de cette migration : voir
  section « Suite à faire » plus bas.
- `{ user: {...} }` devient `{ data: { user: {...} } }`.

### Endpoints exclus du wrapping

| Endpoint | Raison |
|----------|--------|
| `POST /webhooks/mtn-momo` | MTN n'attend pas un shape custom — passthrough natif via `@SkipResponseWrap()` sur `WebhookController` |
| Tout autre webhook externe futur | Annoter le controller avec `@SkipResponseWrap()` |
| Réponses `StreamableFile` (binaires, exports CSV/PDF futurs) | Auto-détecté par l'intercepteur — pas besoin de décorateur |

Endpoints conservés mais **wrappés malgré tout** (les clients doivent s'adapter) :

- `GET /health` et `GET /health/firebase` → désormais `{ data: { status, ... } }`.
  Render se contente d'un HTTP 200 pour le check de liveness, le corps n'est pas
  parsé. Aucun impact opérationnel.
- `GET /tracking/position` et `POST /tracking/position` (WebSocket à part, pas
  concerné par l'intercepteur HTTP).
- `GET /deliveries/my-missions` (liste brute jusqu'ici) → désormais wrappée.

---

## Migration côté clients

### Phase 1 — Tolérance des deux formes (en parallèle de ce PR)

Côté Flutter (lilia-app, lilia-food-admin, lilia_food_delivery) et Next.js
(lilia-food-web) :

```dart
// Flutter — helper tolérant
T unwrap<T>(dynamic decoded, T Function(dynamic) parse) {
  if (decoded is Map && decoded.containsKey('data')) {
    return parse(decoded['data']);
  }
  return parse(decoded);
}
```

```ts
// TypeScript — helper tolérant
export function unwrap<T>(payload: unknown): T {
  if (
    payload &&
    typeof payload === 'object' &&
    'data' in payload
  ) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}
```

Tous les call sites passent par ce helper. Aucune nouvelle livraison côté
backend ne doit être bloquante pour les apps déjà en production : elles tolèrent
les deux formes simultanément.

### Phase 2 — Backend wrappé partout (cette PR)

Le déploiement de cette PR transforme toutes les réponses non-wrappées en
réponses wrappées. Les clients déployés en Phase 1 continuent de fonctionner.

### Phase 3 — Resserrer la tolérance côté clients (sprint suivant)

Une fois que :

- ce PR est en production stable depuis au moins 2 semaines, ET
- 90 % des installations clients ont la version Phase 1 ou plus,

on peut supprimer la branche « pas de clé `data` » du helper `unwrap` et imposer
le format wrappé.

---

## Suite à faire (post-PR)

Endpoints qui exposent des clés ad-hoc à la racine et qu'on doit migrer sous
`meta` pour rester conformes au contrat v2 :

| Endpoint | Clés à déplacer sous `meta` |
|----------|------------------------------|
| `GET /restaurants` | `count` |
| `GET /deliveries/mine` | `count` |
| `GET /restaurants/:id/clients` | `total`, `page`, `limit` |
| `GET /restaurants/:id/specialties` | `count` |
| `GET /orders/my`, `/orders/restaurant`, `/orders/user/:id` | `count`, `page`, `limit` (à vérifier endpoint par endpoint) |

Pour chaque endpoint, le shape cible est :

```json
{
  "data": [...],
  "meta": { "count": 42, "page": 1, "limit": 20, "total": 100 }
}
```

À tracer dans un ticket Linear de suivi (« API Contract v2 — meta migration »).

---

## Plan de rollback

Si on observe une régression en production :

1. **Rollback rapide (1 ligne)** dans `app.module.ts` — commenter la ligne
   `{ provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor }` et
   redéployer. Les clients Phase 1 fonctionnent toujours puisqu'ils tolèrent
   les deux formes.

2. **Rollback complet** — `git revert` du commit, redéploiement. Aucune
   migration DB n'est impliquée, donc le rollback est immédiat.

3. **Rollback ciblé** — si seul un endpoint pose problème, ajouter
   `@SkipResponseWrap()` sur ce handler / controller spécifique. Pas besoin de
   redéploiement complet du backend.

---

## Tests

`apps/lilia-app/src/common/interceptors/api-response.interceptor.spec.ts`
couvre :

- Wrapping d'array, d'objet, de primitive
- Passthrough de `{ data }`, `{ data, message }`, `{ data, message, meta }`
- Re-wrapping de `{ data, count }` (clé non whitelistée → migration nécessaire)
- `null` / `undefined` → `{ data: null }`
- `StreamableFile` passthrough
- `@SkipResponseWrap()` passthrough
- Contextes non-HTTP (WebSocket, RPC) → no-op
