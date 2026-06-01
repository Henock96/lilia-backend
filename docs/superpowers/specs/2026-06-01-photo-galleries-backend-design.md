# Design — Backend photo galleries (vendor, product, menu)

**Date** : 2026-06-01
**Chantier** : E1 (1er sous-chantier de Photo Galleries — voir E2 admin UI + E3 client display)
**Auteur** : Henok Mipoka + Claude
**Status** : Approved → ready for implementation plan

## Contexte

Aujourd'hui `Restaurant`, `Product` et `MenuDuJour` ont chacun un champ `imageUrl: String?` (une seule image). Les `HOME_COOK` et `BAKERY` en particulier souffrent de ce format minimal : ils ont besoin d'exposer plusieurs angles d'un plat, leur atelier, leur ambiance. Côté client web et mobile, l'UI hero ne montre qu'une image — pas de carrousel.

`Banner` existe mais sert au carousel promotionnel de la home (`displayOrder`, `linkUrl`, `isActive`), pas aux galeries d'entité.

Ce chantier E1 pose la **fondation backend** : 3 nouveaux modèles Prisma + 3 modules NestJS CRUD pour gérer des galeries de jusqu'à 5 photos par entité. Self-service RESTAURATEUR + override ADMIN.

E2 (admin UI Flutter) et E3 (display client mobile + web) sont des chantiers indépendants qui consomment ces endpoints. E1 est shippable seul : testable via Postman, clients existants continuent de consommer `imageUrl` sans rupture.

## Objectif

- Permettre à un RESTAURATEUR d'ajouter jusqu'à 5 photos par entité (restaurant, produit, menu) avec ordre, alt text, et flag cover
- Permettre à un ADMIN de faire pareil (modération / override)
- Exposer des endpoints GET publics pour que les apps clientes affichent les galeries
- Cleanup Cloudinary automatique à la suppression (évite les assets orphelins, dette présente sur Banner)

## Non-objectifs

- Migration des `imageUrl` existants dans les galeries — galerie purement additive
- Upload direct depuis le backend — les clients (admin app, web) uploadent directement vers Cloudinary via le module `cloudinary` existant, puis POST l'URL + publicId au backend
- Display UI client — c'est Chantier E3
- Admin gallery management UI — c'est Chantier E2
- Modération avec workflow d'approbation par photo — out of scope MVP

## Décisions validées par le user

1. **3 modèles séparés** (`VendorPhoto`, `ProductImage`, `MenuImage`) — pas de polymorphisme. Simple, joins Prisma natifs, moins flexible mais plus lisible.
2. **Max 5 photos par entité** — enforced backend, contrôle coût Cloudinary
3. **RESTAURATEUR self-service + ADMIN** — pas d'approbation bloquante, le vendeur gère ses photos
4. **Méta `alt` + `isCover`** — a11y/SEO + photo principale flag
5. **`imageUrl` actuel intact** — pas de migration, galerie purement additive, zéro breaking change

## Architecture

### Schéma Prisma

3 modèles dans `prisma/schema.prisma`, après le bloc `Banner` :

```prisma
model VendorPhoto {
  id           String     @id @default(cuid())
  restaurant   Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  restaurantId String
  url          String
  publicId     String?    // Cloudinary public_id pour cleanup à la suppression
  alt          String?    // Texte alternatif (a11y + SEO)
  displayOrder Int        @default(0)
  isCover      Boolean    @default(false)
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt

  @@index([restaurantId])
  @@index([restaurantId, isCover])
}

model ProductImage {
  id           String   @id @default(cuid())
  product      Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  productId    String
  url          String
  publicId     String?
  alt          String?
  displayOrder Int      @default(0)
  isCover      Boolean  @default(false)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([productId])
  @@index([productId, isCover])
}

model MenuImage {
  id           String     @id @default(cuid())
  menuDuJour   MenuDuJour @relation(fields: [menuDuJourId], references: [id], onDelete: Cascade)
  menuDuJourId String
  url          String
  publicId     String?
  alt          String?
  displayOrder Int        @default(0)
  isCover      Boolean    @default(false)
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt

  @@index([menuDuJourId])
  @@index([menuDuJourId, isCover])
}
```

Relations inverses à ajouter :
- `Restaurant` : `photos VendorPhoto[]`
- `Product` : `images ProductImage[]`
- `MenuDuJour` : `images MenuImage[]`

`Cascade` delete sur la FK garantit que supprimer un Restaurant / Product / Menu nettoie ses photos en DB (pas Cloudinary — voir section Cleanup).

### Migration

Une seule migration `add_photo_galleries` qui :
1. Crée les 3 tables
2. Ajoute les 6 index (2 par table)
3. Ne touche PAS les colonnes `imageUrl` existantes

### Modules NestJS

3 modules parallèles, structure identique :

```
apps/lilia-app/src/modules/
├── vendor-photos/
│   ├── vendor-photos.module.ts
│   ├── vendor-photos.controller.ts
│   ├── vendor-photos.service.ts
│   └── dto/
│       ├── create-vendor-photo.dto.ts
│       ├── update-vendor-photo.dto.ts
│       └── reorder-photos.dto.ts
├── product-images/      (même structure)
├── menu-images/         (même structure)
└── photos-common/
    ├── photos-common.module.ts
    └── photos-common.service.ts  // logique partagée
```

Le module `photos-common` exporte un `PhotosCommonService` injecté dans les 3 modules pour partager :
- Validation `MAX_PHOTOS = 5` (count + reject 400)
- Transaction `setCover(table, entityId, photoId)` qui désactive tous les autres covers et active la cible
- Ownership check `assertOwnership(user, restaurantId)` — délègue à PrismaService

### Endpoints

Chaque module expose 5 endpoints, exemples sur `/vendor-photos` (les 2 autres sont strictement parallèles avec `/product-images` + `productId`, `/menu-images` + `menuDuJourId`) :

| Route | Auth | Body / Query | Description |
|---|---|---|---|
| `POST /vendor-photos` | RESTAURATEUR, ADMIN | `{ restaurantId, url, publicId?, alt?, isCover? }` | Crée une photo. Validate max 5. Si `isCover=true` → transaction qui désactive autres covers. |
| `GET /vendor-photos?restaurantId=:id` | Public | — | Liste les photos d'un restaurant, ordonnées par `displayOrder ASC, createdAt ASC`. |
| `PATCH /vendor-photos/:id` | RESTAURATEUR (owner), ADMIN | `{ alt?, displayOrder?, isCover? }` | Modifie. Si `isCover=true` → transaction. |
| `DELETE /vendor-photos/:id` | RESTAURATEUR (owner), ADMIN | — | Supprime + déclenche `cloudinaryService.destroy(publicId)` non-bloquant (try/catch silencieux) si `publicId` présent. |
| `POST /vendor-photos/reorder` | RESTAURATEUR (owner), ADMIN | `{ restaurantId, ids: string[] }` | Transaction : réécrit `displayOrder` = index dans le tableau pour chaque id. Rejette si un id n'appartient pas à `restaurantId`. |

Pour `/product-images` : la query GET est `?productId=:id`, le body create est `{ productId, ... }`. Ownership = via `product.restaurantId` puis `restaurant.ownerId`.

Pour `/menu-images` : query `?menuDuJourId=:id`, body `{ menuDuJourId, ... }`. Ownership = via `menuDuJour.restaurantId`.

### Ownership / IDOR (sécurité)

Pour les opérations non-publiques :
- **RESTAURATEUR** : le restaurant cible doit avoir `ownerId === user.id`
- **ADMIN** : skip check

Implémentation dans `PhotosCommonService.assertOwnership(user, restaurantId)` :
```typescript
if (user.role === 'ADMIN') return;
const r = await prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { ownerId: true } });
if (!r) throw new NotFoundException('Restaurant introuvable');
if (r.ownerId !== user.id) throw new ForbiddenException();
```

Pour Product et Menu : remonter au restaurant parent puis appeler `assertOwnership`.

### DTOs (class-validator)

```typescript
// create-vendor-photo.dto.ts
export class CreateVendorPhotoDto {
  @IsString() @IsNotEmpty()
  restaurantId: string;

  @IsString() @IsUrl()
  url: string;

  @IsOptional() @IsString()
  publicId?: string;

  @IsOptional() @IsString() @MaxLength(200)
  alt?: string;

  @IsOptional() @IsBoolean()
  isCover?: boolean;
}

// update-vendor-photo.dto.ts
export class UpdateVendorPhotoDto {
  @IsOptional() @IsString() @MaxLength(200)
  alt?: string;

  @IsOptional() @IsInt() @Min(0)
  displayOrder?: number;

  @IsOptional() @IsBoolean()
  isCover?: boolean;
}

// reorder-photos.dto.ts
export class ReorderPhotosDto {
  @IsString() @IsNotEmpty()
  restaurantId: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5)
  @IsString({ each: true })
  ids: string[];
}
```

DTOs équivalents pour Product (FK `productId`) et Menu (FK `menuDuJourId`).

### Cleanup Cloudinary

Quand `DELETE /vendor-photos/:id` est appelé et que `publicId` est présent :
```typescript
try {
  await this.cloudinaryService.destroy(publicId);
} catch (err) {
  this.logger.warn(`Cloudinary destroy failed for ${publicId}`, err);
}
```

Non-bloquant, on log et continue. Le DB record est supprimé même si Cloudinary échoue (on évite d'avoir des photos "fantômes" en DB).

**Note dette pré-existante** : `Banner` n'a pas de `publicId` et ne cleanup pas Cloudinary à la suppression. Hors scope ici, à filer comme follow-up si on veut harmoniser.

### Réponses API

Format wrappé par `ApiResponseInterceptor` :
- `GET /vendor-photos?restaurantId=...` → `{ data: VendorPhoto[], count: number }`
- `POST /vendor-photos` → `{ data: VendorPhoto }`
- `PATCH /vendor-photos/:id` → `{ data: VendorPhoto }`
- `DELETE /vendor-photos/:id` → `{ data: { success: true } }`
- `POST /vendor-photos/reorder` → `{ data: VendorPhoto[] }` (les photos avec leur nouveau displayOrder)

### Events

Aucun event nécessaire pour E1. Pas de notification FCM sur changement de photo (ce n'est pas un événement business important).

## Edge cases & risques

- **isCover : transactions concurrentes** — deux PATCH simultanés qui activent isCover sur 2 photos différentes pourraient tous deux désactiver l'autre puis réactiver le leur. Le résultat dépend de l'ordre d'exécution. Acceptable : un cover est un état mutable, le dernier writer gagne. Si vraiment problématique, un lock optimiste sur la version du restaurant. Pour MVP, on laisse.
- **Photo orphelinée sur Cloudinary** si `Restaurant.delete` cascade-delete les `VendorPhoto` en DB → la cascade ne déclenche pas notre logique service (pas de hook Prisma). **Mitigation** : à la suppression d'un Restaurant, ajouter un step manuel dans `RestaurantsService.remove` qui fetch toutes les photos, call cloudinary.destroy en boucle, PUIS delete. Hors scope strict E1 mais à mentionner — solution : on documente comme dette à régler en E2 ou hors chantier.
- **Reorder avec ID étranger** — si le tableau contient un id qui n'appartient pas à `restaurantId`, on rollback la transaction et 400. DTO validate la longueur ≤ 5 mais pas l'appartenance — vérif côté service.
- **Reorder avec ID manquant** — si une photo existe en DB mais pas dans le tableau d'ids, on laisse son displayOrder inchangé (l'utilisateur n'a peut-être que partiellement ordonné). Décision UX : sur le front, on enverra toujours TOUS les ids dans le tableau. Le service tolère un sous-ensemble.
- **Photo très lourde** — Cloudinary gère le redimensionnement, on ne stocke que l'URL. Pas de validation taille côté backend (le frontend a déjà compressé).
- **URL non-Cloudinary** — DTO valide `@IsUrl()` seul. Si le frontend post une URL externe (ex: imgur), c'est accepté mais Cloudinary destroy ne fera rien (publicId absent ou invalide → log warning silencieux). Acceptable pour MVP — anti-fraude pourra être ajouté plus tard si abus.
- **Race POST avec count = 4 → 5** — deux POST simultanés sur la même entité quand count = 4 peuvent passer tous deux le check (read-then-write race). Résultat : 6 photos en DB. Très rare, on accepte pour MVP. Pour fix : `prisma.$transaction` avec lock applicatif sur l'entité.

## Plan de vérification manuelle (Postman / curl)

Pas d'E2E test automatisé pour ce chantier (à confirmer la convention sur ce repo). Checklist :

1. `npm run start:dev` lance le serveur sur 8080
2. Auth : récupérer un Firebase ID token RESTAURATEUR + un ADMIN
3. **VendorPhoto happy path** :
   - POST avec photo URL valide → 201 + photo retournée
   - GET avec restaurantId → liste contient la photo
   - PATCH avec `isCover: true` → photo a `isCover=true`, autres covers du restaurant ont `isCover=false`
   - POST autre photo `isCover: true` → la précédente passe `isCover=false`
   - DELETE → 200, photo retirée, Cloudinary destroy appelé (log visible si publicId présent)
4. **Validation max 5** :
   - POST 5 photos → OK
   - 6ème POST → 400 BadRequest avec message "Maximum 5 photos par restaurant"
5. **IDOR** :
   - RESTAURATEUR A tente POST sur restaurant de RESTAURATEUR B → 403 Forbidden
   - ADMIN tente même chose → 201 OK
6. **Reorder** :
   - POST /reorder avec `{ ids: [p3, p1, p2] }` → photos ont `displayOrder` 0/1/2 dans cet ordre
   - POST /reorder avec un id étranger → 400 ou 403
7. **ProductImage et MenuImage** : refaire les étapes 3-6
8. **Cascade delete** :
   - Supprimer un Restaurant → les `VendorPhoto` associées sont supprimées en DB (vérifier en Prisma Studio). Note : Cloudinary assets restent (dette documentée)

## Inventaire des changements

| Layer | Fichier | Type |
|---|---|---|
| Schema | `prisma/schema.prisma` | Modify (+3 models, +3 relations inverses, ~70 lignes) |
| Migration | `prisma/migrations/<timestamp>_add_photo_galleries/migration.sql` | **New** (généré par `migrate dev`) |
| Module common | `apps/lilia-app/src/modules/photos-common/photos-common.module.ts` | **New** (~15 lignes) |
| Module common | `apps/lilia-app/src/modules/photos-common/photos-common.service.ts` | **New** (~80 lignes) |
| Module vendor | `apps/lilia-app/src/modules/vendor-photos/vendor-photos.module.ts` | **New** (~20 lignes) |
| Module vendor | `apps/lilia-app/src/modules/vendor-photos/vendor-photos.controller.ts` | **New** (~80 lignes) |
| Module vendor | `apps/lilia-app/src/modules/vendor-photos/vendor-photos.service.ts` | **New** (~120 lignes) |
| Module vendor | `apps/lilia-app/src/modules/vendor-photos/dto/*.dto.ts` | **New** (3 fichiers, ~60 lignes) |
| Module product | `apps/lilia-app/src/modules/product-images/...` | **New** (structure identique, ~280 lignes total) |
| Module menu | `apps/lilia-app/src/modules/menu-images/...` | **New** (structure identique, ~280 lignes total) |
| App module | `apps/lilia-app/src/app.module.ts` | Modify (3 imports + 3 entries dans `imports: []`) |

Total estimé : ~1100 lignes de nouveau code, ~1 migration.

## Branche Git

`hmipoka/photo-galleries-backend`, branchée depuis `master`.

`dev` n'est pas traversée par ce chantier (le backend a ses propres branches feature qui mergent direct vers master via PR).

## Suite (hors scope E1)

- **Chantier E2 — Admin UI** : 3 écrans Flutter pour gérer galeries vendor / product / menu, drag-reorder, upload via `image_picker` + Cloudinary direct upload, POST à nos endpoints
- **Chantier E3 — Display client** : carousels dans `lilia-app` (mobile) et `lilia-food-web` (web). Réutilise les hooks `useVendorPhotos`, `useProductImages`, `useMenuImages` côté web et providers Riverpod côté mobile
- **Dette à mentionner en suivi** : `Banner` n'a pas de `publicId` ni de Cloudinary cleanup. À harmoniser un jour pour éviter les assets orphelins lors d'une refonte du carousel home.
