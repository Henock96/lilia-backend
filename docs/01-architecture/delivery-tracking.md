# Delivery tracking — source de vérité & dual path

> Réf : LIL-54. Statut : **Redis = source de vérité temps réel**, DB = historique
> + persistance. Les deux endpoints d'update convergent vers Redis.

## TL;DR

| Aspect | Système | Détail |
|--------|---------|--------|
| **Position live (temps réel)** | **Redis** | `driver_positions` (GEO) + `delivery:{orderId}` (JSON, TTL 5 min). C'est ce que lit un client au `order:watch`. **Source de vérité.** |
| **Historique / persistance** | **PostgreSQL** | `Delivery.lastLatitude/lastLongitude/lastPositionAt` + `DeliveryLocation[]` (trace). Pour rapports / forensics. Pas la source live. |
| **Diffusion** | **WebSocket** | broadcast `driver:position { lat, lng, eta, timestamp }` aux rooms `order:{orderId}`. |

Si Redis et DB divergent, **Redis fait foi pour la position courante**. La DB
peut être en retard (persistée au plus 1×/min côté WS) — c'est attendu.

## Les deux paths d'update (et quand les utiliser)

Le livreur (`lilia_food_delivery`) pousse sa position par **deux canaux** :

### 1. `POST /tracking/position` — WebSocket, voie principale
- Handler : `TrackingService.updatePosition`.
- Fait : `cacheLivePosition` (Redis GEO + `delivery:{orderId}`) **+** persist DB
  throttlée (verrou `persist_lock:{orderId}`, max 1 write/min) **+** broadcast WS.
- C'est la voie **par défaut** : lag < 1 s, Redis GEO, pas de flood DB.

### 2. `PATCH /deliveries/:id/location` — HTTP, fallback
- Handler : `DeliveriesService.updateLocation`.
- Utilisé quand le WebSocket est indisponible (réseau Congo instable). L'app
  livreur l'appelle ~toutes les 15 s en fallback.
- Fait : write DB **à chaque appel** (`Delivery` + `DeliveryLocation`) **+**
  `cacheLivePosition` (mêmes clés Redis que le path WS) **+** broadcast WS
  (`source: 'http-delivery'`).

### Convergence (LIL-54)
Les deux paths appellent **`TrackingService.cacheLivePosition`** (extrait
exprès) → Redis (`driver_positions` + `delivery:{orderId}`) est **toujours** à
jour, quel que soit le canal. Un client qui (re)`order:watch` lit donc la
dernière position même si le livreur est en fallback HTTP.

Différence assumée : la **cadence DB** diffère (WS = throttlé 1/min ; HTTP =
chaque appel). C'est voulu — la DB n'est pas la source live, et le fallback HTTP
étant déjà rare, son historique plus dense est sans risque de flood.

`cacheLivePosition` est **best-effort** : no-op si `REDIS_URL` absent (le path
HTTP continue d'écrire la DB ; en dev sans Redis, le tracking live est
simplement indisponible — comportement attendu).

## Lecture côté client

```
order:watch (WS)         -> getLastPosition() lit Redis delivery:{orderId}
driver:position (WS)     -> push live (les 2 paths broadcastent)
GET /deliveries/by-order/:orderId (HTTP, fallback 30s) -> lit la DB (lastLat/Lng)
```

Le client privilégie le WS ; le poll HTTP DB (30 s) n'est qu'un filet de
sécurité et peut être légèrement en retard sur Redis — acceptable.

## ETA
`TrackingService.calculateETA` (Haversine, 25 km/h Brazzaville) — calculée à
chaque broadcast (WS et HTTP), incluse dans le payload `driver:position`.

## Invariants à préserver
- Tout nouveau path d'update de position **doit** appeler `cacheLivePosition`
  (sinon réintroduction de la divergence LIL-54).
- Ne jamais traiter la DB comme la position courante : toujours passer par Redis
  (`getLastPosition`) pour le live.
