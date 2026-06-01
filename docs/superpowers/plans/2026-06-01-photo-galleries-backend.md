# Backend Photo Galleries (E1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fondation backend pour galeries multi-photos sur Restaurant, Product et MenuDuJour : 3 nouveaux modèles Prisma + 3 modules NestJS CRUD + cleanup Cloudinary.

**Architecture:** 3 modèles Prisma parallèles (`VendorPhoto`, `ProductImage`, `MenuImage`), un service partagé `PhotosCommonService` pour validation `max 5` + IDOR + transaction isCover, et 3 modules NestJS quasi-identiques. Aucune migration de `imageUrl` existant (additif pur).

**Tech Stack:** NestJS + Prisma + PostgreSQL + Firebase Admin + Cloudinary v2.

**Spec source:** `docs/superpowers/specs/2026-06-01-photo-galleries-backend-design.md`

---

## Pré-requis : branche Git

Crée la branche **avant** Task A1 (déjà créée pour le spec).

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend
git status   # working tree clean attendu
git branch --show-current   # → hmipoka/photo-galleries-backend
```

Le HEAD doit avoir le commit `docs(spec): backend photo galleries (vendor, product, menu) — Chantier E1`.

---

## Phase A — Schéma Prisma + migration + Cloudinary export

### Task A1: Ajouter les 3 modèles + relations inverses dans `schema.prisma`

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Localiser le modèle Banner**

```bash
grep -n "^model Banner\b" prisma/schema.prisma
```
Tu verras typiquement `model Banner {` autour de la ligne 612. Les 3 nouveaux modèles vont s'insérer juste après le bloc Banner (avant `model OperatingHours`).

- [ ] **Step 2: Insérer les 3 modèles après Banner**

Après le `}` de fin du bloc `model Banner`, et avant `model OperatingHours`, insérer :

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

- [ ] **Step 3: Ajouter la relation inverse `photos VendorPhoto[]` sur `Restaurant`**

Localiser le bloc `model Restaurant` (autour ligne 90). Repérer la ligne `banners                 Banner[]          // ...` (~ligne 109). Juste après, ajouter :
```prisma
  photos                  VendorPhoto[]     // Galerie photos vendeur
```

- [ ] **Step 4: Ajouter la relation inverse `images ProductImage[]` sur `Product`**

Localiser le bloc `model Product` (autour ligne 223). Repérer la ligne `cartItems      CartItem[]` (~ligne 238). Juste après, ajouter :
```prisma
  images         ProductImage[]   // Galerie photos produit
```

- [ ] **Step 5: Ajouter la relation inverse `images MenuImage[]` sur `MenuDuJour`**

Localiser le bloc `model MenuDuJour` (autour ligne 184). Repérer la ligne `cartItems     CartItem[]` (~ligne 201). Juste après, ajouter :
```prisma
  images        MenuImage[]    // Galerie photos menu
```

- [ ] **Step 6: Format check du schema**

Run:
```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend && npx prisma format
```
Expected: pas d'erreur, alignement du formatage.

### Task A2: Générer la migration

**Files:**
- Create: `prisma/migrations/<timestamp>_add_photo_galleries/migration.sql` (généré)

- [ ] **Step 1: Run migrate dev**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend && npx prisma migrate dev --name add_photo_galleries
```

Expected:
- Une nouvelle migration créée sous `prisma/migrations/<timestamp>_add_photo_galleries/migration.sql`
- 3 `CREATE TABLE` (vendor_photos, product_images, menu_images) — vérifier que les tables suivent la convention snake_case si la base existante l'utilise (sinon camelCase Prisma natif)
- 6 `CREATE INDEX`
- `npx prisma generate` s'exécute en cascade (types Prisma à jour)

Si la migration échoue à cause d'une DB partagée (collègues / staging), créer la migration localement avec `npx prisma migrate dev --create-only --name add_photo_galleries` puis appliquer manuellement.

- [ ] **Step 2: Inspecter la migration générée**

```bash
ls prisma/migrations/ | tail -3
cat $(ls -td prisma/migrations/*/ | head -1)migration.sql
```
Confirmer que la migration ne touche QUE les nouvelles tables / index (pas de DROP TABLE accidentel).

### Task A3: Exporter CloudinaryService du module

**Files:**
- Modify: `apps/lilia-app/src/modules/cloudinary/cloudinary.module.ts`

- [ ] **Step 1: Ajouter `exports`**

Le fichier actuel :
```typescript
import { Module } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';

@Module({
  providers: [CloudinaryService]
})
export class CloudinaryModule {}
```

Remplacer par :
```typescript
import { Module } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';

@Module({
  providers: [CloudinaryService],
  exports: [CloudinaryService],
})
export class CloudinaryModule {}
```

Sans cet `exports`, les 3 modules photos ne pourront pas injecter `CloudinaryService`.

### Task A4: Commit Phase A

- [ ] **Step 1: Commit**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend
git add prisma/schema.prisma prisma/migrations apps/lilia-app/src/modules/cloudinary/cloudinary.module.ts
git commit -m "$(cat <<'EOF'
feat(prisma): 3 models VendorPhoto + ProductImage + MenuImage + exports Cloudinary

- VendorPhoto, ProductImage, MenuImage avec url, publicId?, alt?, displayOrder,
  isCover, timestamps + cascade delete sur la FK
- Index (entityId) + (entityId, isCover) sur chaque table
- Relations inverses photos/images sur Restaurant, Product, MenuDuJour
- CloudinaryModule exporte CloudinaryService pour injection cross-module

Foundation pour Chantier E1 (backend photo galleries).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — PhotosCommonService (logique partagée)

### Task B1: Créer le module commun

**Files:**
- Create: `apps/lilia-app/src/modules/photos-common/photos-common.module.ts`
- Create: `apps/lilia-app/src/modules/photos-common/photos-common.service.ts`

- [ ] **Step 1: Créer le dossier**

```bash
mkdir -p apps/lilia-app/src/modules/photos-common
```

- [ ] **Step 2: Créer `photos-common.service.ts`**

```typescript
import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';

export const MAX_PHOTOS_PER_ENTITY = 5;

/**
 * Tables Prisma supportées par le service partagé. Chaque entrée doit
 * avoir un champ `restaurantId | productId | menuDuJourId`, un `isCover`
 * boolean, un `publicId` string?, et un `displayOrder` int.
 */
export type PhotoTable = 'vendorPhoto' | 'productImage' | 'menuImage';

@Injectable()
export class PhotosCommonService {
  private readonly logger = new Logger(PhotosCommonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /**
   * Vérifie que l'utilisateur peut muter une entité du restaurant cible.
   * ADMIN passe toujours. RESTAURATEUR doit être owner du restaurant.
   * Lance ForbiddenException sinon. NotFound si restaurant introuvable.
   */
  async assertRestaurantOwnership(
    restaurantId: string,
    user: { id: string; role: string },
  ): Promise<void> {
    if (user.role === 'ADMIN') return;
    const r = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { ownerId: true },
    });
    if (!r) throw new NotFoundException('Restaurant introuvable');
    if (r.ownerId !== user.id) {
      throw new ForbiddenException('Vous n\'êtes pas propriétaire de ce restaurant');
    }
  }

  /**
   * Vérifie que le nombre de photos pour une entité ne dépasse pas la limite.
   * Lance BadRequestException si MAX atteint.
   */
  async assertUnderMax(table: PhotoTable, where: object): Promise<void> {
    const count = await this.countByEntity(table, where);
    if (count >= MAX_PHOTOS_PER_ENTITY) {
      throw new BadRequestException(
        `Maximum ${MAX_PHOTOS_PER_ENTITY} photos par entité`,
      );
    }
  }

  /**
   * Désactive `isCover` sur toutes les photos de l'entité sauf celle pointée.
   * Utilisé avant d'activer un nouveau cover pour garantir l'invariant
   * "au plus un cover par entité".
   * À appeler dans une transaction par le service appelant.
   */
  async demoteOtherCovers(
    table: PhotoTable,
    where: object,
    keepId: string | null,
  ): Promise<void> {
    const filter = keepId ? { ...where, NOT: { id: keepId } } : where;
    await (this.prisma[table] as { updateMany: Function }).updateMany({
      where: { ...filter, isCover: true },
      data: { isCover: false },
    });
  }

  /**
   * Cleanup Cloudinary non-bloquant. Log warn si échec.
   */
  async cleanupCloudinary(publicId: string | null | undefined): Promise<void> {
    if (!publicId) return;
    try {
      await this.cloudinary.deleteImage(publicId);
    } catch (err) {
      this.logger.warn(
        `Cloudinary deleteImage failed for ${publicId}: ${(err as Error).message}`,
      );
    }
  }

  private async countByEntity(table: PhotoTable, where: object): Promise<number> {
    return (this.prisma[table] as { count: Function }).count({ where });
  }
}
```

Note sur le typage du `prisma[table]` : Prisma Client n'expose pas un type union des delegates. On caste localement pour éviter la verbosité. C'est OK car on contrôle les 3 valeurs possibles via le type `PhotoTable`.

- [ ] **Step 3: Créer `photos-common.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { PhotosCommonService } from './photos-common.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';

@Module({
  imports: [CloudinaryModule],
  providers: [PhotosCommonService, PrismaService],
  exports: [PhotosCommonService],
})
export class PhotosCommonModule {}
```

### Task B2: Test unitaire du PhotosCommonService

**Files:**
- Create: `apps/lilia-app/src/modules/photos-common/photos-common.service.spec.ts`

Suit la convention des autres `*.service.spec.ts` (ex: `preorder-validator.service.spec.ts`).

- [ ] **Step 1: Écrire le fichier de test**

```typescript
/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PhotosCommonService, MAX_PHOTOS_PER_ENTITY } from './photos-common.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';

/**
 * Tests unitaires PhotosCommonService.
 * Prisma + Cloudinary mockés au minimum nécessaire à chaque cas.
 */
describe('PhotosCommonService', () => {
  let service: PhotosCommonService;
  let prismaMock: any;
  let cloudinaryMock: any;

  beforeEach(() => {
    prismaMock = {
      restaurant: { findUnique: jest.fn() },
      vendorPhoto: { count: jest.fn(), updateMany: jest.fn() },
      productImage: { count: jest.fn(), updateMany: jest.fn() },
      menuImage: { count: jest.fn(), updateMany: jest.fn() },
    };
    cloudinaryMock = { deleteImage: jest.fn() };
    service = new PhotosCommonService(
      prismaMock as PrismaService,
      cloudinaryMock as CloudinaryService,
    );
  });

  describe('assertRestaurantOwnership', () => {
    it('no-op si user.role === ADMIN', async () => {
      await service.assertRestaurantOwnership('r_1', { id: 'u_admin', role: 'ADMIN' });
      expect(prismaMock.restaurant.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFound si restaurant inconnu', async () => {
      prismaMock.restaurant.findUnique.mockResolvedValue(null);
      await expect(
        service.assertRestaurantOwnership('r_missing', { id: 'u_1', role: 'RESTAURATEUR' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws Forbidden si owner différent', async () => {
      prismaMock.restaurant.findUnique.mockResolvedValue({ ownerId: 'u_other' });
      await expect(
        service.assertRestaurantOwnership('r_1', { id: 'u_1', role: 'RESTAURATEUR' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('no-op si owner === user.id', async () => {
      prismaMock.restaurant.findUnique.mockResolvedValue({ ownerId: 'u_1' });
      await expect(
        service.assertRestaurantOwnership('r_1', { id: 'u_1', role: 'RESTAURATEUR' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertUnderMax', () => {
    it('no-op si count < MAX', async () => {
      prismaMock.vendorPhoto.count.mockResolvedValue(MAX_PHOTOS_PER_ENTITY - 1);
      await expect(
        service.assertUnderMax('vendorPhoto', { restaurantId: 'r_1' }),
      ).resolves.toBeUndefined();
    });

    it('throws BadRequest si count >= MAX', async () => {
      prismaMock.vendorPhoto.count.mockResolvedValue(MAX_PHOTOS_PER_ENTITY);
      await expect(
        service.assertUnderMax('vendorPhoto', { restaurantId: 'r_1' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('demoteOtherCovers', () => {
    it('met isCover=false sur autres photos de l\'entité (avec keepId)', async () => {
      await service.demoteOtherCovers('vendorPhoto', { restaurantId: 'r_1' }, 'photo_keep');
      expect(prismaMock.vendorPhoto.updateMany).toHaveBeenCalledWith({
        where: { restaurantId: 'r_1', NOT: { id: 'photo_keep' }, isCover: true },
        data: { isCover: false },
      });
    });

    it('met isCover=false sur toutes les photos (sans keepId)', async () => {
      await service.demoteOtherCovers('vendorPhoto', { restaurantId: 'r_1' }, null);
      expect(prismaMock.vendorPhoto.updateMany).toHaveBeenCalledWith({
        where: { restaurantId: 'r_1', isCover: true },
        data: { isCover: false },
      });
    });
  });

  describe('cleanupCloudinary', () => {
    it('no-op si publicId est null', async () => {
      await service.cleanupCloudinary(null);
      expect(cloudinaryMock.deleteImage).not.toHaveBeenCalled();
    });

    it('no-op si publicId est undefined', async () => {
      await service.cleanupCloudinary(undefined);
      expect(cloudinaryMock.deleteImage).not.toHaveBeenCalled();
    });

    it('appelle deleteImage si publicId présent', async () => {
      cloudinaryMock.deleteImage.mockResolvedValue(undefined);
      await service.cleanupCloudinary('lilia-food/restaurants/abc123');
      expect(cloudinaryMock.deleteImage).toHaveBeenCalledWith('lilia-food/restaurants/abc123');
    });

    it('avale silencieusement les erreurs Cloudinary', async () => {
      cloudinaryMock.deleteImage.mockRejectedValue(new Error('Cloudinary down'));
      await expect(
        service.cleanupCloudinary('lilia-food/restaurants/abc123'),
      ).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run le test**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend && npx jest photos-common.service.spec --no-coverage 2>&1 | tail -25
```
Expected : 11 tests passent (4 ownership + 2 max + 2 demote + 4 cloudinary cleanup = 12). Vérifier le compte exact dans la sortie.

### Task B3: Commit Phase B

- [ ] **Step 1: Commit**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend
git add apps/lilia-app/src/modules/photos-common
git commit -m "$(cat <<'EOF'
feat(photos-common): service partagé + tests unitaires

PhotosCommonService :
- assertRestaurantOwnership(restaurantId, user) — IDOR check RESTAURATEUR/ADMIN
- assertUnderMax(table, where) — refuse si déjà MAX_PHOTOS_PER_ENTITY=5
- demoteOtherCovers(table, where, keepId) — invariant un seul isCover
- cleanupCloudinary(publicId) — non-bloquant, log warn si échec

12 tests unitaires couvrent les 4 méthodes (ownership ADMIN/owner/other/missing,
max sous/au seuil, demote avec/sans keepId, cleanup null/undefined/ok/error).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase C — Module VendorPhotos

### Task C1: DTOs

**Files:**
- Create: `apps/lilia-app/src/modules/vendor-photos/dto/create-vendor-photo.dto.ts`
- Create: `apps/lilia-app/src/modules/vendor-photos/dto/update-vendor-photo.dto.ts`
- Create: `apps/lilia-app/src/modules/vendor-photos/dto/reorder-vendor-photos.dto.ts`
- Create: `apps/lilia-app/src/modules/vendor-photos/dto/index.ts`

- [ ] **Step 1: Créer le dossier**

```bash
mkdir -p apps/lilia-app/src/modules/vendor-photos/dto
```

- [ ] **Step 2: `create-vendor-photo.dto.ts`**

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class CreateVendorPhotoDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  restaurantId: string;

  @ApiProperty()
  @IsUrl()
  url: string;

  @ApiPropertyOptional({ description: 'Cloudinary public_id pour cleanup' })
  @IsOptional()
  @IsString()
  publicId?: string;

  @ApiPropertyOptional({ description: 'Texte alternatif (a11y + SEO), max 200 chars' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  alt?: string;

  @ApiPropertyOptional({ description: 'Marque cette photo comme cover (désactive les autres covers)' })
  @IsOptional()
  @IsBoolean()
  isCover?: boolean;
}
```

- [ ] **Step 3: `update-vendor-photo.dto.ts`**

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateVendorPhotoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  alt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isCover?: boolean;
}
```

- [ ] **Step 4: `reorder-vendor-photos.dto.ts`**

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNotEmpty, IsString } from 'class-validator';

export class ReorderVendorPhotosDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  restaurantId: string;

  @ApiProperty({ type: [String], description: 'IDs des photos dans le nouvel ordre' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  ids: string[];
}
```

- [ ] **Step 5: `index.ts`**

```typescript
export * from './create-vendor-photo.dto';
export * from './update-vendor-photo.dto';
export * from './reorder-vendor-photos.dto';
```

### Task C2: Service

**Files:**
- Create: `apps/lilia-app/src/modules/vendor-photos/vendor-photos.service.ts`

- [ ] **Step 1: Écrire le service**

```typescript
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PhotosCommonService } from '../photos-common/photos-common.service';
import {
  CreateVendorPhotoDto,
  UpdateVendorPhotoDto,
  ReorderVendorPhotosDto,
} from './dto';

@Injectable()
export class VendorPhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly common: PhotosCommonService,
  ) {}

  async list(restaurantId: string) {
    return this.prisma.vendorPhoto.findMany({
      where: { restaurantId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(dto: CreateVendorPhotoDto, user: { id: string; role: string }) {
    await this.common.assertRestaurantOwnership(dto.restaurantId, user);
    await this.common.assertUnderMax('vendorPhoto', { restaurantId: dto.restaurantId });

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover) {
        await tx.vendorPhoto.updateMany({
          where: { restaurantId: dto.restaurantId, isCover: true },
          data: { isCover: false },
        });
      }
      return tx.vendorPhoto.create({
        data: {
          restaurantId: dto.restaurantId,
          url: dto.url,
          publicId: dto.publicId ?? null,
          alt: dto.alt ?? null,
          isCover: dto.isCover ?? false,
        },
      });
    });
  }

  async update(
    id: string,
    dto: UpdateVendorPhotoDto,
    user: { id: string; role: string },
  ) {
    const photo = await this.prisma.vendorPhoto.findUnique({ where: { id } });
    if (!photo) throw new NotFoundException('Photo introuvable');
    await this.common.assertRestaurantOwnership(photo.restaurantId, user);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover === true) {
        await tx.vendorPhoto.updateMany({
          where: { restaurantId: photo.restaurantId, NOT: { id }, isCover: true },
          data: { isCover: false },
        });
      }
      return tx.vendorPhoto.update({
        where: { id },
        data: {
          ...(dto.alt !== undefined && { alt: dto.alt }),
          ...(dto.displayOrder !== undefined && { displayOrder: dto.displayOrder }),
          ...(dto.isCover !== undefined && { isCover: dto.isCover }),
        },
      });
    });
  }

  async remove(id: string, user: { id: string; role: string }) {
    const photo = await this.prisma.vendorPhoto.findUnique({ where: { id } });
    if (!photo) throw new NotFoundException('Photo introuvable');
    await this.common.assertRestaurantOwnership(photo.restaurantId, user);

    await this.prisma.vendorPhoto.delete({ where: { id } });
    await this.common.cleanupCloudinary(photo.publicId);
    return { success: true };
  }

  async reorder(dto: ReorderVendorPhotosDto, user: { id: string; role: string }) {
    await this.common.assertRestaurantOwnership(dto.restaurantId, user);

    // Vérifier que tous les ids appartiennent au restaurant cible
    const photos = await this.prisma.vendorPhoto.findMany({
      where: { id: { in: dto.ids } },
      select: { id: true, restaurantId: true },
    });
    if (photos.length !== dto.ids.length) {
      throw new BadRequestException('Certaines photos sont introuvables');
    }
    const wrongOwner = photos.find((p) => p.restaurantId !== dto.restaurantId);
    if (wrongOwner) {
      throw new BadRequestException(
        'Certaines photos n\'appartiennent pas au restaurant cible',
      );
    }

    return this.prisma.$transaction(
      dto.ids.map((id, index) =>
        this.prisma.vendorPhoto.update({
          where: { id },
          data: { displayOrder: index },
        }),
      ),
    );
  }
}
```

### Task C3: Controller

**Files:**
- Create: `apps/lilia-app/src/modules/vendor-photos/vendor-photos.controller.ts`

- [ ] **Step 1: Écrire le controller**

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { VendorPhotosService } from './vendor-photos.service';
import {
  CreateVendorPhotoDto,
  UpdateVendorPhotoDto,
  ReorderVendorPhotosDto,
} from './dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('VendorPhotos')
@ApiBearerAuth()
@Controller('vendor-photos')
export class VendorPhotosController {
  constructor(private readonly service: VendorPhotosService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: "Liste les photos d'un restaurant (public)" })
  list(@Query('restaurantId') restaurantId: string) {
    return this.service.list(restaurantId);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Post()
  @ApiOperation({ summary: 'Ajoute une photo au restaurant (max 5)' })
  create(@Body() dto: CreateVendorPhotoDto, @CurrentUser() user: User) {
    return this.service.create(dto, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Modifie alt / displayOrder / isCover' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateVendorPhotoDto,
    @CurrentUser() user: User,
  ) {
    return this.service.update(id, dto, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprime la photo + cleanup Cloudinary' })
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.service.remove(id, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Réordonne les photos (transaction)' })
  reorder(@Body() dto: ReorderVendorPhotosDto, @CurrentUser() user: User) {
    return this.service.reorder(dto, user);
  }
}
```

⚠️ `@CurrentUser()` requiert `@Roles(...)` (sinon `request.user` n'est pas peuplé — voir backend CLAUDE.md). C'est pourquoi le GET est `@Public()` et n'utilise pas `@CurrentUser()`.

### Task C4: Module + wire dans AppModule

**Files:**
- Create: `apps/lilia-app/src/modules/vendor-photos/vendor-photos.module.ts`
- Modify: `apps/lilia-app/src/app.module.ts`

- [ ] **Step 1: Créer le module**

```typescript
import { Module } from '@nestjs/common';
import { VendorPhotosController } from './vendor-photos.controller';
import { VendorPhotosService } from './vendor-photos.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PhotosCommonModule } from '../photos-common/photos-common.module';

@Module({
  imports: [PhotosCommonModule],
  controllers: [VendorPhotosController],
  providers: [VendorPhotosService, PrismaService],
})
export class VendorPhotosModule {}
```

- [ ] **Step 2: Importer dans `app.module.ts`**

Run :
```bash
grep -n "ReviewsModule\|BannersModule" apps/lilia-app/src/app.module.ts | head
```
Tu vois le pattern d'import (top du fichier) + d'usage (`imports: [...]`).

Ajouter au top, après les autres imports de modules :
```typescript
import { VendorPhotosModule } from './modules/vendor-photos/vendor-photos.module';
```

Dans le tableau `imports: []` du `@Module({...})`, ajouter `VendorPhotosModule,` (ordre alphabétique-ish ou en bas de la liste — suivre la convention déjà en place dans le fichier).

- [ ] **Step 3: Build check**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend && npm run build 2>&1 | tail -15
```
Expected : compilation TypeScript clean. Si erreurs, lire les messages — souvent un import path manquant.

### Task C5: Commit Phase C

- [ ] **Step 1: Commit**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend
git add apps/lilia-app/src/modules/vendor-photos apps/lilia-app/src/app.module.ts
git commit -m "$(cat <<'EOF'
feat(vendor-photos): module CRUD + reorder pour galerie restaurant

5 endpoints sur /vendor-photos :
- GET ?restaurantId=:id (public)
- POST (RESTAURATEUR owner / ADMIN)
- PATCH /:id (RESTAURATEUR owner / ADMIN, transaction si isCover)
- DELETE /:id (RESTAURATEUR owner / ADMIN, Cloudinary cleanup)
- POST /reorder (transaction, valide ownership des ids)

Délègue à PhotosCommonService pour IDOR + max + demote covers.
Module wired dans app.module.ts.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase D — Module ProductImages

### Task D1: DTOs

**Files:**
- Create: `apps/lilia-app/src/modules/product-images/dto/create-product-image.dto.ts`
- Create: `apps/lilia-app/src/modules/product-images/dto/update-product-image.dto.ts`
- Create: `apps/lilia-app/src/modules/product-images/dto/reorder-product-images.dto.ts`
- Create: `apps/lilia-app/src/modules/product-images/dto/index.ts`

- [ ] **Step 1: Créer le dossier**

```bash
mkdir -p apps/lilia-app/src/modules/product-images/dto
```

- [ ] **Step 2: `create-product-image.dto.ts`**

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class CreateProductImageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty()
  @IsUrl()
  url: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  publicId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  alt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isCover?: boolean;
}
```

- [ ] **Step 3: `update-product-image.dto.ts`**

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateProductImageDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  alt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isCover?: boolean;
}
```

- [ ] **Step 4: `reorder-product-images.dto.ts`**

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNotEmpty, IsString } from 'class-validator';

export class ReorderProductImagesDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  ids: string[];
}
```

- [ ] **Step 5: `index.ts`**

```typescript
export * from './create-product-image.dto';
export * from './update-product-image.dto';
export * from './reorder-product-images.dto';
```

### Task D2: Service (avec ownership remontée via Product → Restaurant)

**Files:**
- Create: `apps/lilia-app/src/modules/product-images/product-images.service.ts`

- [ ] **Step 1: Écrire le service**

```typescript
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PhotosCommonService } from '../photos-common/photos-common.service';
import {
  CreateProductImageDto,
  UpdateProductImageDto,
  ReorderProductImagesDto,
} from './dto';

@Injectable()
export class ProductImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly common: PhotosCommonService,
  ) {}

  async list(productId: string) {
    return this.prisma.productImage.findMany({
      where: { productId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Remonte au restaurant parent puis délègue à PhotosCommonService.
   * Si productId invalide → NotFound.
   */
  private async assertProductOwnership(
    productId: string,
    user: { id: string; role: string },
  ): Promise<string> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { restaurantId: true },
    });
    if (!product) throw new NotFoundException('Produit introuvable');
    await this.common.assertRestaurantOwnership(product.restaurantId, user);
    return product.restaurantId;
  }

  async create(dto: CreateProductImageDto, user: { id: string; role: string }) {
    await this.assertProductOwnership(dto.productId, user);
    await this.common.assertUnderMax('productImage', { productId: dto.productId });

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover) {
        await tx.productImage.updateMany({
          where: { productId: dto.productId, isCover: true },
          data: { isCover: false },
        });
      }
      return tx.productImage.create({
        data: {
          productId: dto.productId,
          url: dto.url,
          publicId: dto.publicId ?? null,
          alt: dto.alt ?? null,
          isCover: dto.isCover ?? false,
        },
      });
    });
  }

  async update(
    id: string,
    dto: UpdateProductImageDto,
    user: { id: string; role: string },
  ) {
    const image = await this.prisma.productImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Image introuvable');
    await this.assertProductOwnership(image.productId, user);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover === true) {
        await tx.productImage.updateMany({
          where: { productId: image.productId, NOT: { id }, isCover: true },
          data: { isCover: false },
        });
      }
      return tx.productImage.update({
        where: { id },
        data: {
          ...(dto.alt !== undefined && { alt: dto.alt }),
          ...(dto.displayOrder !== undefined && { displayOrder: dto.displayOrder }),
          ...(dto.isCover !== undefined && { isCover: dto.isCover }),
        },
      });
    });
  }

  async remove(id: string, user: { id: string; role: string }) {
    const image = await this.prisma.productImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Image introuvable');
    await this.assertProductOwnership(image.productId, user);

    await this.prisma.productImage.delete({ where: { id } });
    await this.common.cleanupCloudinary(image.publicId);
    return { success: true };
  }

  async reorder(dto: ReorderProductImagesDto, user: { id: string; role: string }) {
    await this.assertProductOwnership(dto.productId, user);

    const images = await this.prisma.productImage.findMany({
      where: { id: { in: dto.ids } },
      select: { id: true, productId: true },
    });
    if (images.length !== dto.ids.length) {
      throw new BadRequestException('Certaines images sont introuvables');
    }
    const wrongOwner = images.find((p) => p.productId !== dto.productId);
    if (wrongOwner) {
      throw new BadRequestException(
        'Certaines images n\'appartiennent pas au produit cible',
      );
    }

    return this.prisma.$transaction(
      dto.ids.map((id, index) =>
        this.prisma.productImage.update({
          where: { id },
          data: { displayOrder: index },
        }),
      ),
    );
  }
}
```

### Task D3: Controller

**Files:**
- Create: `apps/lilia-app/src/modules/product-images/product-images.controller.ts`

- [ ] **Step 1: Écrire le controller**

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProductImagesService } from './product-images.service';
import {
  CreateProductImageDto,
  UpdateProductImageDto,
  ReorderProductImagesDto,
} from './dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('ProductImages')
@ApiBearerAuth()
@Controller('product-images')
export class ProductImagesController {
  constructor(private readonly service: ProductImagesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: "Liste les images d'un produit (public)" })
  list(@Query('productId') productId: string) {
    return this.service.list(productId);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Post()
  @ApiOperation({ summary: 'Ajoute une image au produit (max 5)' })
  create(@Body() dto: CreateProductImageDto, @CurrentUser() user: User) {
    return this.service.create(dto, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Modifie alt / displayOrder / isCover' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductImageDto,
    @CurrentUser() user: User,
  ) {
    return this.service.update(id, dto, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprime l\'image + cleanup Cloudinary' })
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.service.remove(id, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Réordonne les images (transaction)' })
  reorder(@Body() dto: ReorderProductImagesDto, @CurrentUser() user: User) {
    return this.service.reorder(dto, user);
  }
}
```

### Task D4: Module + wire

**Files:**
- Create: `apps/lilia-app/src/modules/product-images/product-images.module.ts`
- Modify: `apps/lilia-app/src/app.module.ts`

- [ ] **Step 1: Créer le module**

```typescript
import { Module } from '@nestjs/common';
import { ProductImagesController } from './product-images.controller';
import { ProductImagesService } from './product-images.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PhotosCommonModule } from '../photos-common/photos-common.module';

@Module({
  imports: [PhotosCommonModule],
  controllers: [ProductImagesController],
  providers: [ProductImagesService, PrismaService],
})
export class ProductImagesModule {}
```

- [ ] **Step 2: Importer dans `app.module.ts`**

Ajouter en haut :
```typescript
import { ProductImagesModule } from './modules/product-images/product-images.module';
```

Et dans `imports: [...]`, ajouter `ProductImagesModule,`.

- [ ] **Step 3: Build check**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend && npm run build 2>&1 | tail -10
```

### Task D5: Commit Phase D

- [ ] **Step 1: Commit**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend
git add apps/lilia-app/src/modules/product-images apps/lilia-app/src/app.module.ts
git commit -m "$(cat <<'EOF'
feat(product-images): module CRUD + reorder pour galerie produit

5 endpoints sur /product-images, ownership remontée via Product.restaurantId
puis PhotosCommonService.assertRestaurantOwnership. Même pattern que
vendor-photos avec FK productId.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase E — Module MenuImages

### Task E1: DTOs

**Files:**
- Create: `apps/lilia-app/src/modules/menu-images/dto/create-menu-image.dto.ts`
- Create: `apps/lilia-app/src/modules/menu-images/dto/update-menu-image.dto.ts`
- Create: `apps/lilia-app/src/modules/menu-images/dto/reorder-menu-images.dto.ts`
- Create: `apps/lilia-app/src/modules/menu-images/dto/index.ts`

- [ ] **Step 1: Créer le dossier**

```bash
mkdir -p apps/lilia-app/src/modules/menu-images/dto
```

- [ ] **Step 2: `create-menu-image.dto.ts`**

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class CreateMenuImageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  menuDuJourId: string;

  @ApiProperty()
  @IsUrl()
  url: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  publicId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  alt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isCover?: boolean;
}
```

- [ ] **Step 3: `update-menu-image.dto.ts`**

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateMenuImageDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  alt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isCover?: boolean;
}
```

- [ ] **Step 4: `reorder-menu-images.dto.ts`**

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNotEmpty, IsString } from 'class-validator';

export class ReorderMenuImagesDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  menuDuJourId: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  ids: string[];
}
```

- [ ] **Step 5: `index.ts`**

```typescript
export * from './create-menu-image.dto';
export * from './update-menu-image.dto';
export * from './reorder-menu-images.dto';
```

### Task E2: Service (ownership remontée via MenuDuJour → Restaurant)

**Files:**
- Create: `apps/lilia-app/src/modules/menu-images/menu-images.service.ts`

- [ ] **Step 1: Écrire le service**

```typescript
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PhotosCommonService } from '../photos-common/photos-common.service';
import {
  CreateMenuImageDto,
  UpdateMenuImageDto,
  ReorderMenuImagesDto,
} from './dto';

@Injectable()
export class MenuImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly common: PhotosCommonService,
  ) {}

  async list(menuDuJourId: string) {
    return this.prisma.menuImage.findMany({
      where: { menuDuJourId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private async assertMenuOwnership(
    menuDuJourId: string,
    user: { id: string; role: string },
  ): Promise<string> {
    const menu = await this.prisma.menuDuJour.findUnique({
      where: { id: menuDuJourId },
      select: { restaurantId: true },
    });
    if (!menu) throw new NotFoundException('Menu introuvable');
    await this.common.assertRestaurantOwnership(menu.restaurantId, user);
    return menu.restaurantId;
  }

  async create(dto: CreateMenuImageDto, user: { id: string; role: string }) {
    await this.assertMenuOwnership(dto.menuDuJourId, user);
    await this.common.assertUnderMax('menuImage', { menuDuJourId: dto.menuDuJourId });

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover) {
        await tx.menuImage.updateMany({
          where: { menuDuJourId: dto.menuDuJourId, isCover: true },
          data: { isCover: false },
        });
      }
      return tx.menuImage.create({
        data: {
          menuDuJourId: dto.menuDuJourId,
          url: dto.url,
          publicId: dto.publicId ?? null,
          alt: dto.alt ?? null,
          isCover: dto.isCover ?? false,
        },
      });
    });
  }

  async update(
    id: string,
    dto: UpdateMenuImageDto,
    user: { id: string; role: string },
  ) {
    const image = await this.prisma.menuImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Image introuvable');
    await this.assertMenuOwnership(image.menuDuJourId, user);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover === true) {
        await tx.menuImage.updateMany({
          where: { menuDuJourId: image.menuDuJourId, NOT: { id }, isCover: true },
          data: { isCover: false },
        });
      }
      return tx.menuImage.update({
        where: { id },
        data: {
          ...(dto.alt !== undefined && { alt: dto.alt }),
          ...(dto.displayOrder !== undefined && { displayOrder: dto.displayOrder }),
          ...(dto.isCover !== undefined && { isCover: dto.isCover }),
        },
      });
    });
  }

  async remove(id: string, user: { id: string; role: string }) {
    const image = await this.prisma.menuImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Image introuvable');
    await this.assertMenuOwnership(image.menuDuJourId, user);

    await this.prisma.menuImage.delete({ where: { id } });
    await this.common.cleanupCloudinary(image.publicId);
    return { success: true };
  }

  async reorder(dto: ReorderMenuImagesDto, user: { id: string; role: string }) {
    await this.assertMenuOwnership(dto.menuDuJourId, user);

    const images = await this.prisma.menuImage.findMany({
      where: { id: { in: dto.ids } },
      select: { id: true, menuDuJourId: true },
    });
    if (images.length !== dto.ids.length) {
      throw new BadRequestException('Certaines images sont introuvables');
    }
    const wrongOwner = images.find((p) => p.menuDuJourId !== dto.menuDuJourId);
    if (wrongOwner) {
      throw new BadRequestException(
        'Certaines images n\'appartiennent pas au menu cible',
      );
    }

    return this.prisma.$transaction(
      dto.ids.map((id, index) =>
        this.prisma.menuImage.update({
          where: { id },
          data: { displayOrder: index },
        }),
      ),
    );
  }
}
```

### Task E3: Controller

**Files:**
- Create: `apps/lilia-app/src/modules/menu-images/menu-images.controller.ts`

- [ ] **Step 1: Écrire le controller**

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MenuImagesService } from './menu-images.service';
import {
  CreateMenuImageDto,
  UpdateMenuImageDto,
  ReorderMenuImagesDto,
} from './dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('MenuImages')
@ApiBearerAuth()
@Controller('menu-images')
export class MenuImagesController {
  constructor(private readonly service: MenuImagesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: "Liste les images d'un menu (public)" })
  list(@Query('menuDuJourId') menuDuJourId: string) {
    return this.service.list(menuDuJourId);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Post()
  @ApiOperation({ summary: 'Ajoute une image au menu (max 5)' })
  create(@Body() dto: CreateMenuImageDto, @CurrentUser() user: User) {
    return this.service.create(dto, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Modifie alt / displayOrder / isCover' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateMenuImageDto,
    @CurrentUser() user: User,
  ) {
    return this.service.update(id, dto, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprime l\'image + cleanup Cloudinary' })
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.service.remove(id, user);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Réordonne les images (transaction)' })
  reorder(@Body() dto: ReorderMenuImagesDto, @CurrentUser() user: User) {
    return this.service.reorder(dto, user);
  }
}
```

### Task E4: Module + wire

**Files:**
- Create: `apps/lilia-app/src/modules/menu-images/menu-images.module.ts`
- Modify: `apps/lilia-app/src/app.module.ts`

- [ ] **Step 1: Créer le module**

```typescript
import { Module } from '@nestjs/common';
import { MenuImagesController } from './menu-images.controller';
import { MenuImagesService } from './menu-images.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PhotosCommonModule } from '../photos-common/photos-common.module';

@Module({
  imports: [PhotosCommonModule],
  controllers: [MenuImagesController],
  providers: [MenuImagesService, PrismaService],
})
export class MenuImagesModule {}
```

- [ ] **Step 2: Importer dans `app.module.ts`**

Ajouter en haut :
```typescript
import { MenuImagesModule } from './modules/menu-images/menu-images.module';
```

Et dans `imports: [...]`, ajouter `MenuImagesModule,`.

- [ ] **Step 3: Build check**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend && npm run build 2>&1 | tail -10
```

### Task E5: Commit Phase E

- [ ] **Step 1: Commit**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend
git add apps/lilia-app/src/modules/menu-images apps/lilia-app/src/app.module.ts
git commit -m "$(cat <<'EOF'
feat(menu-images): module CRUD + reorder pour galerie menu

5 endpoints sur /menu-images, ownership remontée via MenuDuJour.restaurantId
puis PhotosCommonService.assertRestaurantOwnership. Même pattern que
product-images avec FK menuDuJourId.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase F — Vérification

### Task F1: Build full + tests

- [ ] **Step 1: Build**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend && npm run build 2>&1 | tail -10
```
Expected : zéro erreur TS.

- [ ] **Step 2: Tests unitaires**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend && npx jest photos-common --no-coverage 2>&1 | tail -15
```
Expected : 12 tests passent (Phase B).

- [ ] **Step 3: Sanity grep**

```bash
grep -n "VendorPhotosModule\|ProductImagesModule\|MenuImagesModule" apps/lilia-app/src/app.module.ts
```
Expected : 3 imports + 3 entrées dans `imports: [...]` (6 lignes).

### Task F2: Smoke test manuel (l'humain le fait)

Pas exécutable par un sub-agent. Documentation :

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend && npm run start:dev
```

Checklist via Postman ou curl + Firebase ID token RESTAURATEUR / ADMIN :

1. **VendorPhoto happy path** :
   - `POST /vendor-photos` body `{ restaurantId: "<resto_owned>", url: "https://...", alt: "Devanture" }` → 201 + photo retournée
   - `GET /vendor-photos?restaurantId=<resto_owned>` → liste contient la photo
   - `PATCH /vendor-photos/:id` body `{ isCover: true }` → la photo a `isCover=true`, autres covers du resto → false
   - `POST /vendor-photos` 4 fois pour atteindre 5 photos total → tous OK
   - 6ème `POST` → `400 BadRequest` "Maximum 5 photos par entité"
   - `DELETE /vendor-photos/:id` → 200, log Cloudinary visible si publicId fourni
2. **IDOR** :
   - RESTAURATEUR A tente `POST /vendor-photos` avec restaurantId de RESTAURATEUR B → `403 Forbidden`
   - ADMIN même requête → 201 OK
3. **Reorder** :
   - 3 photos avec displayOrder 0/1/2, `POST /vendor-photos/reorder` body `{ restaurantId, ids: [p3, p1, p2] }` → la liste GET retourne dans cet ordre, displayOrder = 0/1/2 respectivement
   - Reorder avec un id d'un autre restaurant → 400 BadRequest
4. **ProductImage et MenuImage** : refaire 1+2+3 sur `/product-images?productId=...` et `/menu-images?menuDuJourId=...`
5. **Cascade delete** :
   - Créer un Product avec 2 ProductImage
   - Supprimer le Product en DB (Prisma Studio ou autre route)
   - Vérifier que les 2 ProductImage sont supprimées en DB (cascade)
   - Note : les assets Cloudinary correspondants restent (dette documentée, hors scope E1)

### Task F3: Push branche

- [ ] **Step 1: Push**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend
git push -u origin hmipoka/photo-galleries-backend 2>&1 | tail -10
```

Expected : branche poussée, GitHub propose URL de PR.

### Task F4: PR

L'humain crée la PR via GitHub. Description suggérée :

```markdown
## Summary
- Chantier E1 : fondation backend pour galeries photos multi-entités
- 3 modèles Prisma (VendorPhoto, ProductImage, MenuImage) + 1 migration
- 3 modules NestJS avec 5 endpoints chacun (GET public, POST/PATCH/DELETE/reorder authentifiés RESTAURATEUR/ADMIN)
- PhotosCommonService partagé pour IDOR + max 5 + invariant isCover + cleanup Cloudinary
- 12 tests unitaires sur PhotosCommonService
- imageUrl existant inchangé → zéro breaking change pour les clients actuels

## Test plan
- [x] `npm run build` clean
- [x] Tests unitaires photos-common passent
- [ ] Smoke test Postman checklist (voir docs/superpowers/plans/2026-06-01-photo-galleries-backend.md Phase F Task F2)
- [ ] Vérification cascade delete sur Restaurant / Product / MenuDuJour

## Suite
Chantiers E2 (admin Flutter UI) et E3 (display mobile + web) qui consomment ces endpoints.
```

---

## Récap commits attendus

| Phase | Commit |
|---|---|
| A4 | `feat(prisma): 3 models VendorPhoto + ProductImage + MenuImage + exports Cloudinary` |
| B3 | `feat(photos-common): service partagé + tests unitaires` |
| C5 | `feat(vendor-photos): module CRUD + reorder pour galerie restaurant` |
| D5 | `feat(product-images): module CRUD + reorder pour galerie produit` |
| E5 | `feat(menu-images): module CRUD + reorder pour galerie menu` |

5 commits, 1 branche, 1 PR.
