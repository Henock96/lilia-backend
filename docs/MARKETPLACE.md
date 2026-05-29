# Marketplace multi-vendeurs (LIL-110)

Extension du modèle Restaurant en plateforme multi-vendeurs. Le terme
"vendeur" désigne désormais un Restaurant typé via `vendorType`. Cette
doc résume les sprints A → E livrés en mai 2026.

## Types de vendeurs (enum `VendorType`)

| Type | Description | Auto-approuvé ? |
|---|---|---|
| `RESTAURANT` | Flux historique inchangé | Oui |
| `HOME_COOK` | Pâtissiers, traiteurs, vendeurs maison | Non — admin valide |
| `BAKERY` | Boulangeries, viennoiseries | Non — admin valide |
| `BEVERAGE_SHOP` | Sodas, jus, eaux, boissons importées **non-alcoolisées** | Non — admin valide |
| `GROCERY` | Réservé futur | Non — admin valide |

### Décision produit (mai 2026) — pas d'alcool au lancement

`ProductType.ALCOHOL` existe dans l'enum DB mais `ProductValidatorService`
le rejette systématiquement. Les colonnes `Restaurant.minAgeRequired`,
`Product.alcoholContent / vintage / origin / volumeMl` sont conservées en
dead fields pour permettre la réintroduction sans migration.

## Approbation admin (frontière de sécurité)

Tout vendeur non-RESTAURANT créé via `POST /vendors` ou
`POST /admin/restaurants` est `adminApproved = false` par défaut.

Trois couches filtrent les vendeurs non approuvés :

1. `GET /vendors` (marketplace public) — `WHERE isActive AND adminApproved`
2. `GET /products` (catalogue public) — `WHERE restaurant.isActive AND restaurant.adminApproved`
3. `OrderValidator.validateRestaurantOpen` — rejette au checkout (defense in depth)

Suspension réversible : `PATCH /admin/vendors/:id/suspend` body `{ reason }`
met `isActive = false` sans toucher `adminApproved`. Réversible via
`toggleRestaurantActive(id, true)`.

## Matrice de compatibilité produit

`ProductValidatorService.assertProductTypeAllowed(vendorType, productType)` :

| Vendor | Product types autorisés |
|---|---|
| `RESTAURANT` | `FOOD`, `BEVERAGE` |
| `HOME_COOK` | `FOOD`, `PASTRY` |
| `BAKERY` | `PASTRY`, `FOOD` |
| `BEVERAGE_SHOP` | `BEVERAGE` |
| `GROCERY` | `GROCERY`, `BEVERAGE` |
| *tous* | `ALCOHOL` → rejet systématique |

## Précommandes et capacité

`PreorderValidatorService` (vendors/) — appelé par `OrdersService.createOrderFromCart` :

- `validatePreorderRequest(scheduledFor, vendor)` :
  - vérifie `vendor.acceptsPreorders`
  - applique `vendor.preorderLeadHours ?? 24` (heures minimum à l'avance)
  - cap à 7 jours
- `validateDailyCapacity(vendor)` :
  - compte les commandes du jour (exclut `ANNULER`)
  - rejette si `>= vendor.maxOrdersPerDay`

## Stock — `StockMode`

- `DAILY` (défaut) : reset chaque nuit via cron `handleDailyStockReset`
- `PERMANENT` : épargné par le cron, décrémentation réelle uniquement

`handleDailyStockReset` filtre `AND "stockMode" = 'DAILY'` pour ne pas
restaurer le stock d'un BEVERAGE_SHOP ou GROCERY.

## Endpoints

### Marketplace public

| Méthode | Route | Filtre |
|---|---|---|
| `GET` | `/vendors` | `vendorType`, `isOpen`, `page`, `limit` |
| `GET` | `/vendors/:id` | — |
| `GET` | `/products` | `productType`, `vendorType`, `restaurantId`, `categoryId` |

### Vendeurs (authentifiés)

| Méthode | Route | Rôles |
|---|---|---|
| `POST` | `/vendors` | `ADMIN` |
| `PATCH` | `/vendors/:id/approve` | `ADMIN` |
| `PUT` | `/vendors/:id/profile` | `RESTAURATEUR`, `ADMIN` (IDOR-safe : check sur `caller.role`) |

### Admin marketplace

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/admin/vendors` | Vue complète : filtres `vendorType`, `adminApproved`, `isActive` |
| `GET` | `/admin/vendors/pending` | Raccourci badge "à valider" |
| `PATCH` | `/admin/vendors/:id/approve` | Délègue à `VendorsService` (mêmes events) |
| `PATCH` | `/admin/vendors/:id/suspend` | body `{ reason }` |
| `POST` | `/admin/restaurants` | Étendu avec `vendorType` + champs vendeur |

### Dashboard admin

| Méthode | Route | Réponse |
|---|---|---|
| `GET` | `/dashboard/vendors` | `{ total, pendingApproval, suspended, byType }` |

## Events

| Event | Émetteur | Listener | Action |
|---|---|---|---|
| `vendor.created` | `VendorsService.createVendor` | `VendorsListener` | Push admin "à valider" si non auto-approuvé |
| `vendor.approved` | `VendorsService.approveVendor` | `VendorsListener` | Push au owner "🎉 votre boutique est en ligne" |

## Tests

```bash
# Validators (pure logic)
npx jest apps/lilia-app/src/modules/products/product-validator.service.spec.ts
npx jest apps/lilia-app/src/modules/vendors/preorder-validator.service.spec.ts

# Smoke DI
npx jest apps/lilia-app/src/modules/vendors/vendors.service.spec.ts
```

## Historique des sprints

| Sprint | Linear | Branche | Contenu |
|---|---|---|---|
| A | LIL-111 | `hmipoka/lil-111-sprint-a-...` | Schema Prisma : `VendorType`, `ProductType`, `StockMode`, `VendorProfile`, champs Restaurant/Product/Order |
| B | LIL-112 | `hmipoka/lil-112-sprint-b-...` | Module `vendors/`, `PreorderValidator`, intégration Orders, listener admin |
| C | LIL-113 | `hmipoka/lil-113-sprint-c-...` | Admin endpoints validation + dashboard stats + extension `createRestaurantWithOwner` |
| D | LIL-114 | `hmipoka/lil-114-sprint-d-...` | DTOs produits multi-vendeurs, `ProductValidator`, filtres marketplace |
| E | LIL-115 | `hmipoka/lil-115-sprint-e-...` | Tests unitaires validators + doc |

Pivot mid-flight (Sprint B / LIL-112) : suppression du flux alcool — voir
mémoire `project-lilia-no-alcohol-initial`.
