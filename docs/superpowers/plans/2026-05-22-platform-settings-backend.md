# Module `platform-settings` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Créer un module backend `platform-settings` qui stocke les paramètres économiques de la plateforme (frais de service, fidélité, parrainage, mode maintenance) dans une ligne Prisma singleton, exposés en lecture/écriture à l'admin, et câblés dans les chemins critiques commande/livraison.

**Architecture:** Modèle Prisma `PlatformSettings` (singleton). `PlatformSettingsService` lit la ligne avec un cache mémoire TTL 60 s. `PlatformSettingsController` expose `GET`/`PATCH /admin/platform-settings` (ADMIN). `MaintenanceGuard` bloque `POST /orders/checkout` en mode maintenance. Les constantes en dur de `OrderCalculator`/`OrdersService`/`DeliveriesService` sont remplacées par les valeurs des settings.

**Tech Stack:** NestJS (`apps/lilia-app`), Prisma + PostgreSQL, Jest (`PrismaService` mocké).

**Référence design :** `docs/superpowers/specs/2026-05-22-platform-settings-backend-design.md`.

---

## File Structure

| Fichier | Rôle | Action |
|---|---|---|
| `prisma/schema.prisma` | Modèle `PlatformSettings` | Modifier |
| `apps/lilia-app/src/modules/platform-settings/platform-settings.service.ts` | Lecture cache + update | Créer |
| `apps/lilia-app/src/modules/platform-settings/platform-settings.service.spec.ts` | Tests service | Créer |
| `apps/lilia-app/src/modules/platform-settings/dto/update-platform-settings.dto.ts` | DTO PATCH | Créer |
| `apps/lilia-app/src/modules/platform-settings/platform-settings.controller.ts` | Routes admin | Créer |
| `apps/lilia-app/src/modules/platform-settings/platform-settings.module.ts` | Module | Créer |
| `apps/lilia-app/src/modules/platform-settings/guards/maintenance.guard.ts` | Guard checkout | Créer |
| `apps/lilia-app/src/modules/platform-settings/guards/maintenance.guard.spec.ts` | Tests guard | Créer |
| `apps/lilia-app/src/app.module.ts` | Enregistrer le module | Modifier |
| `apps/lilia-app/src/modules/orders/order-calculator.service.ts` | Frais service paramétrés | Modifier |
| `apps/lilia-app/src/modules/orders/orders.service.ts` | Câblage settings | Modifier |
| `apps/lilia-app/src/modules/orders/orders.module.ts` | Import du module | Modifier |
| `apps/lilia-app/src/modules/orders/orders.controller.ts` | Guard sur checkout | Modifier |
| `apps/lilia-app/src/modules/deliveries/deliveries.service.ts` | Câblage settings | Modifier |
| `apps/lilia-app/src/modules/deliveries/deliveries.module.ts` | Import du module | Modifier |

---

## Task 1: Modèle Prisma `PlatformSettings` + migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Ajouter le modèle**

À la fin de `prisma/schema.prisma`, ajouter :

```prisma
model PlatformSettings {
  id                     String   @id @default("singleton")

  serviceFeePercent      Float    @default(8)

  loyaltyPointsPer100Xaf Int      @default(1)
  loyaltyPointValueXaf   Int      @default(5)
  loyaltyMinRedemption   Int      @default(100)

  referrerBonusPoints    Int      @default(500)
  referredBonusPoints    Int      @default(200)

  maintenanceMode        Boolean  @default(false)
  maintenanceMessage     String?

  updatedAt              DateTime @updatedAt
}
```

- [ ] **Step 2: Générer et appliquer la migration**

Run: `npx prisma migrate dev --name add_platform_settings`
Expected: une migration créée sous `prisma/migrations/`, table `PlatformSettings` créée, `prisma generate` exécuté automatiquement.

Si aucun accès à la base de données : `npx prisma migrate dev --name add_platform_settings --create-only` puis `npx prisma generate` — la migration est générée sans être appliquée (à appliquer au déploiement).

- [ ] **Step 3: Vérifier que le client Prisma connaît le modèle**

Run: `node -e "const {PrismaClient}=require('@prisma/client'); new PrismaClient().platformSettings; console.log('ok')"`
Expected: affiche `ok` (le modèle `platformSettings` existe sur le client généré).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(prisma): add PlatformSettings singleton model"
```

---

## Task 2: DTO + `PlatformSettingsService` avec cache TTL

**Files:**
- Create: `apps/lilia-app/src/modules/platform-settings/dto/update-platform-settings.dto.ts`
- Create: `apps/lilia-app/src/modules/platform-settings/platform-settings.service.ts`
- Test: `apps/lilia-app/src/modules/platform-settings/platform-settings.service.spec.ts`

- [ ] **Step 1: Écrire les tests qui échouent**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { PlatformSettingsService } from './platform-settings.service';
import { PrismaService } from '../../prisma/prisma.service';

const ROW = {
  id: 'singleton',
  serviceFeePercent: 8,
  loyaltyPointsPer100Xaf: 1,
  loyaltyPointValueXaf: 5,
  loyaltyMinRedemption: 100,
  referrerBonusPoints: 500,
  referredBonusPoints: 200,
  maintenanceMode: false,
  maintenanceMessage: null,
  updatedAt: new Date(),
};

describe('PlatformSettingsService', () => {
  let service: PlatformSettingsService;
  let prisma: { platformSettings: { upsert: jest.Mock } };

  beforeEach(async () => {
    jest.useFakeTimers();
    prisma = { platformSettings: { upsert: jest.fn().mockResolvedValue(ROW) } };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformSettingsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(PlatformSettingsService);
  });

  afterEach(() => jest.useRealTimers());

  it('lit la ligne singleton et la met en cache (2ᵉ appel sans requête DB)', async () => {
    await service.getSettings();
    await service.getSettings();
    expect(prisma.platformSettings.upsert).toHaveBeenCalledTimes(1);
  });

  it('refait la requête après expiration du TTL (60 s)', async () => {
    await service.getSettings();
    jest.advanceTimersByTime(61_000);
    await service.getSettings();
    expect(prisma.platformSettings.upsert).toHaveBeenCalledTimes(2);
  });

  it('updateSettings vide le cache — la lecture suivante refait la requête', async () => {
    await service.getSettings();
    await service.updateSettings({ serviceFeePercent: 10 });
    await service.getSettings();
    // 1er getSettings + updateSettings + getSettings après invalidation = 3 upserts
    expect(prisma.platformSettings.upsert).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- platform-settings.service.spec.ts`
Expected: FAIL — `Cannot find module './platform-settings.service'`.

- [ ] **Step 3: Créer le DTO puis le service**

D'abord le DTO — `dto/update-platform-settings.dto.ts` (tous les champs optionnels, validés via `class-validator`) :

```typescript
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdatePlatformSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  serviceFeePercent?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  loyaltyPointsPer100Xaf?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  loyaltyPointValueXaf?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  loyaltyMinRedemption?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  referrerBonusPoints?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  referredBonusPoints?: number;

  @IsOptional()
  @IsBoolean()
  maintenanceMode?: boolean;

  @IsOptional()
  @IsString()
  maintenanceMessage?: string;
}
```

Puis le service — `platform-settings.service.ts` :

```typescript
import { Injectable } from '@nestjs/common';
import { PlatformSettings } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';

const SINGLETON_ID = 'singleton';
const CACHE_TTL_MS = 60_000;

@Injectable()
export class PlatformSettingsService {
  private cache: PlatformSettings | null = null;
  private cacheExpiry = 0;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne la configuration plateforme. Mise en cache mémoire 60 s :
   * les valeurs sont lues sur les chemins critiques (chaque commande),
   * et changent rarement. Le TTL assure l'auto-réparation multi-instances.
   */
  async getSettings(): Promise<PlatformSettings> {
    if (this.cache && Date.now() < this.cacheExpiry) {
      return this.cache;
    }
    const settings = await this.prisma.platformSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
    });
    this.cache = settings;
    this.cacheExpiry = Date.now() + CACHE_TTL_MS;
    return settings;
  }

  /**
   * Met à jour la configuration (PATCH partiel) et invalide le cache.
   */
  async updateSettings(dto: UpdatePlatformSettingsDto): Promise<PlatformSettings> {
    const settings = await this.prisma.platformSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...dto },
      update: { ...dto },
    });
    this.cache = null;
    this.cacheExpiry = 0;
    return settings;
  }
}
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npm test -- platform-settings.service.spec.ts`
Expected: les 3 tests passent.

- [ ] **Step 5: Commit**

```bash
git add apps/lilia-app/src/modules/platform-settings/dto apps/lilia-app/src/modules/platform-settings/platform-settings.service.ts apps/lilia-app/src/modules/platform-settings/platform-settings.service.spec.ts
git commit -m "feat(platform-settings): add update DTO and cached settings service"
```

---

## Task 3: Controller et module

**Files:**
- Create: `apps/lilia-app/src/modules/platform-settings/platform-settings.controller.ts`
- Create: `apps/lilia-app/src/modules/platform-settings/platform-settings.module.ts`
- Modify: `apps/lilia-app/src/app.module.ts`

- [ ] **Step 1: Créer le controller**

`platform-settings.controller.ts` :

```typescript
import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { PlatformSettingsService } from './platform-settings.service';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';

/**
 * Configuration plateforme — ADMIN uniquement.
 * Guards globaux actifs (APP_GUARD) — pas de @UseGuards() nécessaire.
 */
@ApiTags('Platform Settings')
@ApiBearerAuth()
@Controller('admin/platform-settings')
@Roles('ADMIN')
export class PlatformSettingsController {
  constructor(private readonly service: PlatformSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Configuration plateforme' })
  async get() {
    return { data: await this.service.getSettings() };
  }

  @Patch()
  @ApiOperation({ summary: 'Mettre à jour la configuration plateforme' })
  async update(@Body() dto: UpdatePlatformSettingsDto) {
    return { data: await this.service.updateSettings(dto) };
  }
}
```

- [ ] **Step 2: Créer le module**

`platform-settings.module.ts` :

```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformSettingsController } from './platform-settings.controller';
import { MaintenanceGuard } from './guards/maintenance.guard';

@Module({
  imports: [PrismaModule],
  controllers: [PlatformSettingsController],
  providers: [PlatformSettingsService, MaintenanceGuard],
  exports: [PlatformSettingsService, MaintenanceGuard],
})
export class PlatformSettingsModule {}
```

Note : `MaintenanceGuard` est créé à la Task 4 — l'import sera résolu à ce moment.

- [ ] **Step 3: Enregistrer le module dans `app.module.ts`**

Dans `apps/lilia-app/src/app.module.ts`, dans le tableau `imports`, ajouter `PlatformSettingsModule` juste après `AdminModule` — et ajouter l'import en tête de fichier :

```typescript
import { PlatformSettingsModule } from './modules/platform-settings/platform-settings.module';
```

- [ ] **Step 4: Commit**

```bash
git add apps/lilia-app/src/modules/platform-settings/platform-settings.controller.ts apps/lilia-app/src/modules/platform-settings/platform-settings.module.ts apps/lilia-app/src/app.module.ts
git commit -m "feat(platform-settings): add admin GET/PATCH endpoints"
```

---

## Task 4: `MaintenanceGuard`

Le guard lit d'abord les settings (cache, quasi-gratuit). Mode maintenance inactif → laisse passer sans requête DB. Actif → requête le rôle de l'utilisateur ; ADMIN passe, sinon `503`.

**Files:**
- Create: `apps/lilia-app/src/modules/platform-settings/guards/maintenance.guard.ts`
- Test: `apps/lilia-app/src/modules/platform-settings/guards/maintenance.guard.spec.ts`

- [ ] **Step 1: Écrire les tests qui échouent**

```typescript
import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { MaintenanceGuard } from './maintenance.guard';

function ctx(firebaseUid = 'fb-1'): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ firebaseUser: { uid: firebaseUid } }) }),
  } as unknown as ExecutionContext;
}

describe('MaintenanceGuard', () => {
  let guard: MaintenanceGuard;
  let settings: { getSettings: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };

  beforeEach(() => {
    settings = { getSettings: jest.fn() };
    prisma = { user: { findUnique: jest.fn() } };
    guard = new MaintenanceGuard(settings as any, prisma as any);
  });

  it('laisse passer quand le mode maintenance est inactif (sans requête user)', async () => {
    settings.getSettings.mockResolvedValue({ maintenanceMode: false });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('laisse passer un ADMIN même en mode maintenance', async () => {
    settings.getSettings.mockResolvedValue({ maintenanceMode: true, maintenanceMessage: 'X' });
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it('bloque un non-admin en mode maintenance avec ServiceUnavailableException', async () => {
    settings.getSettings.mockResolvedValue({ maintenanceMode: true, maintenanceMessage: 'Maintenance en cours' });
    prisma.user.findUnique.mockResolvedValue({ role: 'CLIENT' });
    await expect(guard.canActivate(ctx())).rejects.toThrow(ServiceUnavailableException);
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- maintenance.guard.spec.ts`
Expected: FAIL — `Cannot find module './maintenance.guard'`.

- [ ] **Step 3: Implémenter le guard**

```typescript
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DecodedIdToken } from 'firebase-admin/auth';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings.service';

/**
 * Bloque la route checkout quand le mode maintenance est actif.
 * L'ADMIN passe outre. Posé uniquement sur POST /orders/checkout.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const settings = await this.settings.getSettings();
    if (!settings.maintenanceMode) return true;

    const request = context.switchToHttp().getRequest<{ firebaseUser?: DecodedIdToken }>();
    const firebaseUid = request.firebaseUser?.uid;
    const user = firebaseUid
      ? await this.prisma.user.findUnique({
          where: { firebaseUid },
          select: { role: true },
        })
      : null;

    if (user?.role === 'ADMIN') return true;

    throw new ServiceUnavailableException(
      settings.maintenanceMessage ||
        'La plateforme est en maintenance. Réessayez dans quelques instants.',
    );
  }
}
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npm test -- maintenance.guard.spec.ts`
Expected: les 3 tests passent.

- [ ] **Step 5: Commit**

```bash
git add apps/lilia-app/src/modules/platform-settings/guards
git commit -m "feat(platform-settings): add MaintenanceGuard"
```

---

## Task 5: Poser le `MaintenanceGuard` sur le checkout

**Files:**
- Modify: `apps/lilia-app/src/modules/orders/orders.module.ts`
- Modify: `apps/lilia-app/src/modules/orders/orders.controller.ts`

- [ ] **Step 1: Importer `PlatformSettingsModule` dans `OrdersModule`**

Dans `orders.module.ts`, ajouter l'import en tête :

```typescript
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
```

et l'ajouter au tableau `imports` : `imports: [PrismaModule, NotificationsModule, TrackingModule, PlatformSettingsModule],`

- [ ] **Step 2: Poser le guard sur la route checkout**

Dans `orders.controller.ts`, ajouter les imports :

```typescript
import { UseGuards } from '@nestjs/common';
import { MaintenanceGuard } from '../platform-settings/guards/maintenance.guard';
```

(si `UseGuards` est déjà importé depuis `@nestjs/common`, l'ajouter à l'import existant plutôt que d'en créer un second.)

Puis, sur la route `@Post('checkout')`, ajouter le décorateur `@UseGuards(MaintenanceGuard)` juste sous `@Post('checkout')` :

```typescript
  @Post('checkout')
  @UseGuards(MaintenanceGuard)
  @ApiOperation({ summary: 'Créer une commande depuis le panier' })
```

- [ ] **Step 3: Vérifier la compilation**

Run: `npm run build`
Expected: build OK (les 16 erreurs préexistantes du module `notion`/`bullmq` sont hors périmètre — aucune nouvelle erreur dans `orders` ou `platform-settings`).

- [ ] **Step 4: Commit**

```bash
git add apps/lilia-app/src/modules/orders/orders.module.ts apps/lilia-app/src/modules/orders/orders.controller.ts
git commit -m "feat(orders): block checkout when maintenance mode is on"
```

---

## Task 6: Câbler `serviceFeePercent` dans `OrderCalculator`

`OrderCalculatorService.calculate()` reste une unité pure : elle reçoit le pourcentage en paramètre. Unique appelant : `orders.service.ts:165`.

**Files:**
- Modify: `apps/lilia-app/src/modules/orders/order-calculator.service.ts`
- Modify: `apps/lilia-app/src/modules/orders/orders.service.ts`

- [ ] **Step 1: Paramétrer `calculate()`**

Dans `order-calculator.service.ts` :

1. Supprimer la ligne `export const SERVICE_FEE_RATE = 0.08;`.
2. Ajouter un 4ᵉ paramètre `serviceFeePercent` à `calculate` et l'utiliser :

```typescript
  calculate(
    cartItems: any[],
    deliveryFee: number,
    isDelivery: boolean,
    serviceFeePercent: number,
  ): OrderAmounts {
```

et remplacer la ligne du calcul :

```typescript
    const serviceFee = Math.round(subTotal * serviceFeePercent / 100);
```

- [ ] **Step 2: Injecter `PlatformSettingsService` dans `OrdersService` et passer le pourcentage**

Dans `orders.service.ts` :

1. Ajouter l'import : `import { PlatformSettingsService } from '../platform-settings/platform-settings.service';`
2. Ajouter au constructeur, après `private readonly config: ConfigService,` :
   `private readonly platformSettings: PlatformSettingsService,`
3. Dans `createOrderFromCart`, avant l'appel `this.calculator.calculate(...)` (vers la ligne 165), récupérer les settings une fois :

```typescript
    const settings = await this.platformSettings.getSettings();
```

4. Passer le pourcentage à `calculate` :

```typescript
    const amounts = this.calculator.calculate(
      cartItems,
      restaurant.fixedDeliveryFee,
      isDelivery,
      settings.serviceFeePercent,
    );
```

(La variable `settings` est réutilisée à la Task 7 pour la réduction fidélité.)

- [ ] **Step 3: Vérifier la compilation**

Run: `npm run build`
Expected: build OK, aucune nouvelle erreur dans `orders`.

- [ ] **Step 4: Commit**

```bash
git add apps/lilia-app/src/modules/orders/order-calculator.service.ts apps/lilia-app/src/modules/orders/orders.service.ts
git commit -m "feat(orders): read service fee percent from platform settings"
```

---

## Task 7: Câbler fidélité + parrainage dans `OrdersService`

**Files:**
- Modify: `apps/lilia-app/src/modules/orders/orders.service.ts`

- [ ] **Step 1: Supprimer les constantes statiques**

Supprimer le bloc de constantes (lignes ~50-55) :

```typescript
  // ─── Constantes points de fidélité ──────────────────────────────────────────
  private static readonly POINTS_PER_100_FCFA = 1;
  private static readonly POINT_VALUE_FCFA = 5;
  private static readonly MIN_POINTS_REDEEM = 100;
  private static readonly REFERRER_POINTS = 500;
  private static readonly REFERRED_POINTS = 200;
```

- [ ] **Step 2: Câbler `handleReferralReward`**

Au début de `handleReferralReward`, après la garde `if (orderCount !== 1) return;` et la résolution du `referrer`, récupérer les settings :

```typescript
    const settings = await this.platformSettings.getSettings();
```

Puis remplacer dans le `$transaction` les 4 occurrences :
- `OrdersService.REFERRER_POINTS` → `settings.referrerBonusPoints`
- `OrdersService.REFERRED_POINTS` → `settings.referredBonusPoints`

Et dans le `this.logger.log(...)` final, remplacer `${OrdersService.REFERRER_POINTS}` → `${settings.referrerBonusPoints}` et `${OrdersService.REFERRED_POINTS}` → `${settings.referredBonusPoints}`.

- [ ] **Step 3: Câbler `awardLoyaltyPoints`**

Dans `awardLoyaltyPoints`, remplacer la première ligne du corps :

```typescript
    const settings = await this.platformSettings.getSettings();
    const points = Math.floor(subTotal / 100) * settings.loyaltyPointsPer100Xaf;
```

- [ ] **Step 4: Câbler la réduction fidélité dans `createOrderFromCart`**

Dans le bloc `if (useLoyaltyPoints) { ... }` (vers la ligne 195), remplacer :

```typescript
      if (pts >= OrdersService.MIN_POINTS_REDEEM) {
        loyaltyDiscount = pts * OrdersService.POINT_VALUE_FCFA;
      }
```

par (réutilise la variable `settings` déclarée à la Task 6) :

```typescript
      if (pts >= settings.loyaltyMinRedemption) {
        loyaltyDiscount = pts * settings.loyaltyPointValueXaf;
      }
```

- [ ] **Step 5: Vérifier la compilation**

Run: `npm run build`
Expected: build OK. Aucune référence restante à `OrdersService.REFERRER_POINTS`, `REFERRED_POINTS`, `POINTS_PER_100_FCFA`, `POINT_VALUE_FCFA`, `MIN_POINTS_REDEEM` — vérifier avec :

Run: `grep -n "REFERRER_POINTS\|REFERRED_POINTS\|POINTS_PER_100_FCFA\|POINT_VALUE_FCFA\|MIN_POINTS_REDEEM" apps/lilia-app/src/modules/orders/orders.service.ts`
Expected: aucune sortie.

- [ ] **Step 6: Commit**

```bash
git add apps/lilia-app/src/modules/orders/orders.service.ts
git commit -m "feat(orders): read loyalty and referral settings from platform settings"
```

---

## Task 8: Câbler la fidélité dans `DeliveriesService`

**Files:**
- Modify: `apps/lilia-app/src/modules/deliveries/deliveries.service.ts`
- Modify: `apps/lilia-app/src/modules/deliveries/deliveries.module.ts`

- [ ] **Step 1: Importer `PlatformSettingsModule` dans `DeliveriesModule`**

Dans `deliveries.module.ts`, ajouter l'import en tête :

```typescript
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
```

et l'ajouter au tableau `imports` : `imports: [PrismaModule, NotificationsModule, PlatformSettingsModule],`

- [ ] **Step 2: Injecter le service et câbler `awardLoyaltyPoints`**

Dans `deliveries.service.ts` :

1. Ajouter l'import : `import { PlatformSettingsService } from '../platform-settings/platform-settings.service';`
2. Supprimer la constante `private static readonly POINTS_PER_100_FCFA = 1;`
3. Ajouter au constructeur un paramètre : `private readonly platformSettings: PlatformSettingsService,`
4. Dans `awardLoyaltyPoints`, remplacer la ligne du calcul des points :

```typescript
    const settings = await this.platformSettings.getSettings();
    const points = Math.floor(subTotal / 100) * settings.loyaltyPointsPer100Xaf;
```

- [ ] **Step 3: Vérifier la compilation**

Run: `npm run build`
Expected: build OK.

Run: `grep -n "POINTS_PER_100_FCFA" apps/lilia-app/src/modules/deliveries/deliveries.service.ts`
Expected: aucune sortie.

- [ ] **Step 4: Commit**

```bash
git add apps/lilia-app/src/modules/deliveries/deliveries.service.ts apps/lilia-app/src/modules/deliveries/deliveries.module.ts
git commit -m "feat(deliveries): read loyalty earn rate from platform settings"
```

---

## Task 9: Vérification de bout en bout

- [ ] **Step 1: Suite de tests**

Run: `npm test -- platform-settings`
Expected: PASS — `platform-settings.service.spec.ts` (3 tests) + `maintenance.guard.spec.ts` (3 tests).

- [ ] **Step 2: Build complet**

Run: `npm run build`
Expected: build OK — uniquement les 16 erreurs préexistantes du module `notion`/`bullmq` (hors périmètre). Aucune erreur dans `platform-settings`, `orders`, `deliveries`.

- [ ] **Step 3: Vérification manuelle (backend démarré, token ADMIN)**

```bash
curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" http://localhost:3000/admin/platform-settings
curl -s -X PATCH -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{"maintenanceMode":true,"maintenanceMessage":"Test maintenance"}' \
  http://localhost:3000/admin/platform-settings
```

Expected : `GET` renvoie `{ data: { ...défauts } }` (serviceFeePercent 8, etc.) ; `PATCH` renvoie la config mise à jour. Ensuite, un `POST /orders/checkout` avec un token non-admin doit renvoyer `503` avec le message « Test maintenance ». Remettre `maintenanceMode` à `false` après le test.

- [ ] **Step 4: Vérification de non-régression du calcul**

Avec la configuration aux valeurs par défaut, passer une commande de test et vérifier que `serviceFee`, les points gagnés et les bonus de parrainage sont identiques au comportement d'avant (frais 8 %, 1 pt/100 XAF, parrain 500, filleul 200).

---

## Self-Review

**Couverture du spec :**
- Modèle `PlatformSettings` singleton + migration → Task 1 ✅
- `PlatformSettingsService` cache TTL 60 s → Task 2 ✅
- Endpoints `GET`/`PATCH /admin/platform-settings` ADMIN → Task 3 ✅
- `MaintenanceGuard` sur `POST /orders/checkout` → Tasks 4-5 ✅
- Câblage frais de service → Task 6 ✅
- Câblage fidélité + parrainage (`OrdersService`) → Task 7 ✅
- Câblage fidélité (`DeliveriesService`) → Task 8 ✅
- Tests service + guard → Tasks 2, 4 ✅

**Cohérence des types :** `getSettings()` et `updateSettings()` retournent `PlatformSettings` (type Prisma généré). Les champs lus dans le câblage (`serviceFeePercent`, `loyaltyPointsPer100Xaf`, `loyaltyPointValueXaf`, `loyaltyMinRedemption`, `referrerBonusPoints`, `referredBonusPoints`, `maintenanceMode`, `maintenanceMessage`) correspondent exactement aux colonnes du modèle de la Task 1. `calculate(cartItems, deliveryFee, isDelivery, serviceFeePercent)` — signature cohérente entre la définition (Task 6 Step 1) et l'appel (Task 6 Step 2).

**Non-régression :** les `@default` du modèle = constantes actuelles (8, 1, 5, 100, 500, 200). Tant que l'admin ne modifie rien, le comportement est identique — vérifié explicitement à la Task 9 Step 4.

**Hors périmètre :** les 4 pages web du chantier 4 (plan distinct). Le câblage maintenance sur d'autres routes que checkout.
