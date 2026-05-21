# LIL-79 Backend — Fidélité, parrainage & clients pour l'admin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exposer aux deux apps admin (web + Flutter) les données de fidélité, de parrainage et une liste clients filtrable, via de nouveaux endpoints `/admin/*` et l'enrichissement de `getClientDetail`.

**Architecture:** Tout passe par `AdminController` (préfixe `/admin`, `@Roles('ADMIN')`, guards globaux). La logique vit dans `AdminService` (injection `PrismaService`). Aucune migration Prisma — les champs (`loyaltyPoints`, `referralCode`, `referredByCode`, table `LoyaltyTransaction`, `model Payment`) existent déjà. Réponses wrappées `{ data: ... }` selon la convention du projet.

**Tech Stack:** NestJS (monorepo `apps/lilia-app`), Prisma + PostgreSQL, Jest (`Test.createTestingModule` avec `PrismaService` mocké).

**Périmètre :** Sous-système backend uniquement (chantiers 1-3 du ticket + endpoint admin Paiements du chantier 4). Les plans `lilia-food-web` et `lilia-food-admin` suivront, une fois ces endpoints livrés.

---

## File Structure

| Fichier | Rôle | Action |
|---|---|---|
| `apps/lilia-app/src/modules/admin/admin.service.ts` | Logique métier admin | Modifier — 3 méthodes ajoutées, `getAllClients` étendu |
| `apps/lilia-app/src/modules/admin/admin.controller.ts` | Routes `/admin/*` | Modifier — 3 routes ajoutées, `getAllClients` étendu |
| `apps/lilia-app/src/modules/admin/admin.service.spec.ts` | Tests unitaires `AdminService` | Créer |
| `apps/lilia-app/src/modules/dashboard/dashboard.service.ts` | `getClientDetail` | Modifier — `select` enrichi |

**Endpoints livrés :**
- `GET /admin/clients/:id/loyalty?page&limit` — solde + historique paginé des transactions fidélité
- `GET /admin/clients/:id/referral` — code, parrain, filleuls, filleuls convertis, bonus parrainage gagné
- `GET /admin/clients?page&limit&search` — liste clients filtrable, avec `loyaltyPoints`
- `GET /admin/payments?page&limit&status` — paiements (filtrables par statut, défaut `PENDING`)
- `GET /dashboard/clients/:id` — désormais avec `loyaltyPoints`, `referralCode`, `referredByCode`

---

## Task 1: Scaffolding du fichier de test `AdminService`

`AdminService` dépend de `PrismaService`. On crée un mock réutilisable par toutes les tâches suivantes.

**Files:**
- Test: `apps/lilia-app/src/modules/admin/admin.service.spec.ts`

- [ ] **Step 1: Créer le fichier de test avec mock Prisma**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../../prisma/prisma.service';

type PrismaMock = {
  user: { findUnique: jest.Mock; findMany: jest.Mock; count: jest.Mock };
  loyaltyTransaction: { findMany: jest.Mock; count: jest.Mock; aggregate: jest.Mock };
  payment: { findMany: jest.Mock; count: jest.Mock };
};

function createPrismaMock(): PrismaMock {
  return {
    user: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    loyaltyTransaction: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    payment: { findMany: jest.fn(), count: jest.fn() },
  };
}

describe('AdminService', () => {
  let service: AdminService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [AdminService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<AdminService>(AdminService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il passe**

Run: `npm test -- admin.service.spec.ts`
Expected: PASS — 1 test (`should be defined`).

- [ ] **Step 3: Commit**

```bash
git add apps/lilia-app/src/modules/admin/admin.service.spec.ts
git commit -m "test: scaffold AdminService spec with mocked Prisma"
```

---

## Task 2: `getClientLoyalty` — solde + historique paginé

**Files:**
- Modify: `apps/lilia-app/src/modules/admin/admin.service.ts`
- Test: `apps/lilia-app/src/modules/admin/admin.service.spec.ts`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter ce bloc `describe` dans `admin.service.spec.ts`, avant la fin du `describe('AdminService')` racine :

```typescript
  describe('getClientLoyalty', () => {
    it('lève NotFoundException si le client est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getClientLoyalty('missing')).rejects.toThrow(NotFoundException);
    });

    it('retourne le solde et les transactions paginées', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'c1', loyaltyPoints: 320 });
      const txns = [{ id: 't1', points: 45, reason: '+45 pts — commande livrée', orderId: 'o1', createdAt: new Date() }];
      prisma.loyaltyTransaction.findMany.mockResolvedValue(txns);
      prisma.loyaltyTransaction.count.mockResolvedValue(1);

      const result = await service.getClientLoyalty('c1', 1, 20);

      expect(result).toEqual({
        data: { balance: 320, transactions: txns },
        total: 1,
        page: 1,
        limit: 20,
      });
      expect(prisma.loyaltyTransaction.findMany).toHaveBeenCalledWith({
        where: { userId: 'c1' },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      });
    });
  });
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- admin.service.spec.ts`
Expected: FAIL — `service.getClientLoyalty is not a function`.

- [ ] **Step 3: Implémenter `getClientLoyalty`**

Dans `admin.service.ts`, ajouter la méthode (par ex. juste après `getAllClients`) :

```typescript
  /**
   * Solde de points + historique paginé des transactions de fidélité d'un client.
   * Réservé ADMIN (route protégée au niveau controller).
   */
  async getClientLoyalty(clientId: string, page = 1, limit = 20) {
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, loyaltyPoints: true },
    });
    if (!user) throw new NotFoundException('Client introuvable');

    const [transactions, total] = await Promise.all([
      this.prisma.loyaltyTransaction.findMany({
        where: { userId: clientId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.loyaltyTransaction.count({ where: { userId: clientId } }),
    ]);

    return {
      data: { balance: user.loyaltyPoints, transactions },
      total,
      page,
      limit,
    };
  }
```

`NotFoundException` est déjà importé en tête de `admin.service.ts`.

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npm test -- admin.service.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/lilia-app/src/modules/admin/admin.service.ts apps/lilia-app/src/modules/admin/admin.service.spec.ts
git commit -m "feat(admin): add getClientLoyalty service method"
```

---

## Task 3: `getClientReferral` — stats de parrainage par client

`referralRewarded` est mis à `true` lors de la 1ʳᵉ commande LIVRER du filleul (`orders.service.ts`) → il sert de proxy « filleul converti ». Le bonus parrainage gagné se calcule en sommant les `LoyaltyTransaction` dont la `reason` contient « parrainage ».

**Files:**
- Modify: `apps/lilia-app/src/modules/admin/admin.service.ts`
- Test: `apps/lilia-app/src/modules/admin/admin.service.spec.ts`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter ce `describe` dans `admin.service.spec.ts` :

```typescript
  describe('getClientReferral', () => {
    it('lève NotFoundException si le client est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getClientReferral('missing')).rejects.toThrow(NotFoundException);
    });

    it('agrège filleuls, conversions et bonus de parrainage', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'c1', referralCode: 'BRAZZA42', referredByCode: null,
      });
      prisma.user.count
        .mockResolvedValueOnce(3)  // totalReferrals
        .mockResolvedValueOnce(2); // convertedReferrals
      prisma.loyaltyTransaction.aggregate.mockResolvedValue({ _sum: { points: 1000 } });

      const result = await service.getClientReferral('c1');

      expect(result).toEqual({
        data: {
          referralCode: 'BRAZZA42',
          referredByCode: null,
          totalReferrals: 3,
          convertedReferrals: 2,
          referralBonusEarned: 1000,
        },
      });
      expect(prisma.user.count).toHaveBeenNthCalledWith(2, {
        where: { referredByCode: 'BRAZZA42', referralRewarded: true },
      });
    });

    it('renvoie des compteurs à zéro si le client n\'a pas de code de parrainage', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'c1', referralCode: null, referredByCode: 'OTHER123',
      });
      prisma.loyaltyTransaction.aggregate.mockResolvedValue({ _sum: { points: null } });

      const result = await service.getClientReferral('c1');

      expect(result.data).toEqual({
        referralCode: null,
        referredByCode: 'OTHER123',
        totalReferrals: 0,
        convertedReferrals: 0,
        referralBonusEarned: 0,
      });
      expect(prisma.user.count).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- admin.service.spec.ts`
Expected: FAIL — `service.getClientReferral is not a function`.

- [ ] **Step 3: Implémenter `getClientReferral`**

Dans `admin.service.ts`, après `getClientLoyalty` :

```typescript
  /**
   * Statistiques de parrainage d'un client : son code, le code de son parrain,
   * le nombre de filleuls, ceux convertis (1ʳᵉ commande livrée → referralRewarded),
   * et le total de points gagnés via le parrainage.
   */
  async getClientReferral(clientId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, referralCode: true, referredByCode: true },
    });
    if (!user) throw new NotFoundException('Client introuvable');

    const [totalReferrals, convertedReferrals, bonusAgg] = await Promise.all([
      user.referralCode
        ? this.prisma.user.count({ where: { referredByCode: user.referralCode } })
        : Promise.resolve(0),
      user.referralCode
        ? this.prisma.user.count({
            where: { referredByCode: user.referralCode, referralRewarded: true },
          })
        : Promise.resolve(0),
      this.prisma.loyaltyTransaction.aggregate({
        where: { userId: clientId, reason: { contains: 'parrainage' } },
        _sum: { points: true },
      }),
    ]);

    return {
      data: {
        referralCode: user.referralCode,
        referredByCode: user.referredByCode,
        totalReferrals,
        convertedReferrals,
        referralBonusEarned: bonusAgg._sum.points ?? 0,
      },
    };
  }
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npm test -- admin.service.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/lilia-app/src/modules/admin/admin.service.ts apps/lilia-app/src/modules/admin/admin.service.spec.ts
git commit -m "feat(admin): add getClientReferral service method"
```

---

## Task 4: Étendre `getAllClients` — recherche + `loyaltyPoints`

**Files:**
- Modify: `apps/lilia-app/src/modules/admin/admin.service.ts:224` (`getAllClients`)
- Test: `apps/lilia-app/src/modules/admin/admin.service.spec.ts`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter ce `describe` dans `admin.service.spec.ts` :

```typescript
  describe('getAllClients', () => {
    it('filtre uniquement les CLIENT et renvoie loyaltyPoints', async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: 'c1', nom: 'Awa', loyaltyPoints: 120 },
      ]);
      prisma.user.count.mockResolvedValue(1);

      const result = await service.getAllClients(1, 20);

      expect(result).toEqual({ data: [{ id: 'c1', nom: 'Awa', loyaltyPoints: 120 }], total: 1, page: 1, limit: 20 });
      const args = prisma.user.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ role: 'CLIENT' });
      expect(args.select.loyaltyPoints).toBe(true);
    });

    it('ajoute un filtre OR insensible à la casse quand search est fourni', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.getAllClients(1, 20, 'awa');

      const args = prisma.user.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        role: 'CLIENT',
        OR: [
          { nom: { contains: 'awa', mode: 'insensitive' } },
          { email: { contains: 'awa', mode: 'insensitive' } },
          { phone: { contains: 'awa', mode: 'insensitive' } },
        ],
      });
    });
  });
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- admin.service.spec.ts`
Expected: FAIL — `args.select.loyaltyPoints` vaut `undefined` et le `where` ne contient pas de `OR`.

- [ ] **Step 3: Modifier `getAllClients`**

Remplacer intégralement la méthode `getAllClients` (`admin.service.ts:224`) par :

```typescript
  async getAllClients(page = 1, limit = 20, search?: string) {
    const where: Prisma.UserWhereInput = {
      role: 'CLIENT',
      ...(search && {
        OR: [
          { nom: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [clients, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          imageUrl: true,
          role: true,
          createdAt: true,
          lastLogin: true,
          loyaltyPoints: true,
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data: clients, total, page, limit };
  }
```

Ajouter `Prisma` à l'import `@prisma/client` en tête du fichier — la ligne devient :

```typescript
import { Prisma, Role } from '@prisma/client';
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npm test -- admin.service.spec.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/lilia-app/src/modules/admin/admin.service.ts apps/lilia-app/src/modules/admin/admin.service.spec.ts
git commit -m "feat(admin): add search filter and loyaltyPoints to getAllClients"
```

---

## Task 5: `getPendingPayments` — liste des paiements pour l'admin

Le `model Payment` (`status: PaymentStatus` = `PENDING | SUCCESS | FAILED | CANCELLED`) existe. Aucun endpoint admin ne liste les paiements aujourd'hui. On en ajoute un, filtrable, défaut `PENDING`.

**Files:**
- Modify: `apps/lilia-app/src/modules/admin/admin.service.ts`
- Test: `apps/lilia-app/src/modules/admin/admin.service.spec.ts`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter ce `describe` dans `admin.service.spec.ts` :

```typescript
  describe('getPendingPayments', () => {
    it('filtre sur PENDING par défaut, avec la commande et le client liés', async () => {
      prisma.payment.findMany.mockResolvedValue([{ id: 'p1', amount: 5000, status: 'PENDING' }]);
      prisma.payment.count.mockResolvedValue(1);

      const result = await service.getPendingPayments(1, 20);

      expect(result).toEqual({ data: [{ id: 'p1', amount: 5000, status: 'PENDING' }], total: 1, page: 1, limit: 20 });
      const args = prisma.payment.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ status: 'PENDING' });
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('accepte un statut explicite', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await service.getPendingPayments(1, 20, 'SUCCESS');

      expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual({ status: 'SUCCESS' });
    });
  });
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- admin.service.spec.ts`
Expected: FAIL — `service.getPendingPayments is not a function`.

- [ ] **Step 3: Implémenter `getPendingPayments`**

Dans `admin.service.ts`, ajouter la méthode (par ex. juste après `getAllOrders`) :

```typescript
  /**
   * Liste paginée des paiements pour la supervision admin.
   * Statut par défaut : PENDING (paiements à confirmer manuellement).
   */
  async getPendingPayments(page = 1, limit = 20, status: string = 'PENDING') {
    const where = { status: status as PaymentStatus };

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          order: {
            select: {
              id: true,
              total: true,
              status: true,
              user: { select: { id: true, nom: true, phone: true } },
            },
          },
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return { data: payments, total, page, limit };
  }
```

Ajouter `PaymentStatus` à l'import `@prisma/client` — la ligne devient :

```typescript
import { Prisma, Role, PaymentStatus } from '@prisma/client';
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npm test -- admin.service.spec.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/lilia-app/src/modules/admin/admin.service.ts apps/lilia-app/src/modules/admin/admin.service.spec.ts
git commit -m "feat(admin): add getPendingPayments service method"
```

---

## Task 6: Exposer les routes dans `AdminController`

**Files:**
- Modify: `apps/lilia-app/src/modules/admin/admin.controller.ts`

- [ ] **Step 1: Étendre la route `getAllClients` avec `search`**

Remplacer le bloc `@Get('clients')` (`admin.controller.ts:95-104`) par :

```typescript
  @Get('clients')
  @ApiOperation({ summary: 'Clients uniquement (paginés, recherche optionnelle)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  getAllClients(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('search') search?: string,
  ) {
    return this.adminService.getAllClients(
      parseInt(page, 10),
      parseInt(limit, 10),
      search,
    );
  }

  @Get('clients/:id/loyalty')
  @ApiOperation({ summary: "Solde et historique de fidélité d'un client" })
  @ApiParam({ name: 'id', description: "ID Prisma du client" })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getClientLoyalty(
    @Param('id') id: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.adminService.getClientLoyalty(
      id,
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }

  @Get('clients/:id/referral')
  @ApiOperation({ summary: "Statistiques de parrainage d'un client" })
  @ApiParam({ name: 'id', description: "ID Prisma du client" })
  getClientReferral(@Param('id') id: string) {
    return this.adminService.getClientReferral(id);
  }
```

- [ ] **Step 2: Ajouter la route `payments`**

Juste après le bloc `@Get('orders/active')` (`admin.controller.ts:177`), ajouter :

```typescript
  // ─── PAIEMENTS ─────────────────────────────────────────────────────────────

  @Get('payments')
  @ApiOperation({ summary: 'Paiements (par défaut PENDING) pour supervision' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false })
  getPendingPayments(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('status') status?: string,
  ) {
    return this.adminService.getPendingPayments(
      parseInt(page, 10),
      parseInt(limit, 10),
      status,
    );
  }
```

- [ ] **Step 3: Vérifier la compilation et lancer la suite de tests**

Run: `npm run build`
Expected: build OK, aucune erreur TypeScript.

Run: `npm test -- admin.service.spec.ts`
Expected: PASS — 10 tests.

- [ ] **Step 4: Commit**

```bash
git add apps/lilia-app/src/modules/admin/admin.controller.ts
git commit -m "feat(admin): expose loyalty, referral, client search and payments routes"
```

---

## Task 7: Enrichir `getClientDetail` (fidélité + parrainage)

Le panneau détail web consomme `GET /dashboard/clients/:id`. On y ajoute les champs fidélité/parrainage pour qu'ils s'affichent sans appel supplémentaire.

**Files:**
- Modify: `apps/lilia-app/src/modules/dashboard/dashboard.service.ts:433-444` (`select` de `getClientDetail`)

- [ ] **Step 1: Ajouter les 3 champs au `select`**

Dans `getClientDetail`, le `select` de `this.prisma.user.findUnique` — ajouter `loyaltyPoints`, `referralCode`, `referredByCode` juste après `createdAt: true` :

```typescript
        select: {
          id: true,
          nom: true,
          email: true,
          phone: true,
          imageUrl: true,
          createdAt: true,
          loyaltyPoints: true,
          referralCode: true,
          referredByCode: true,
          adresses: {
            select: { rue: true, ville: true, etat: true, isDefault: true },
            take: 5,
          },
        },
```

- [ ] **Step 2: Vérifier la compilation**

Run: `npm run build`
Expected: build OK.

- [ ] **Step 3: Vérification manuelle**

Démarrer le backend (`npm run start:dev`) et, avec un token ADMIN :

Run: `curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" "http://localhost:3000/dashboard/clients/<CLIENT_ID>" | npx json --tab data.client`
Expected: l'objet `client` du JSON contient désormais `loyaltyPoints`, `referralCode`, `referredByCode`.

- [ ] **Step 4: Commit**

```bash
git add apps/lilia-app/src/modules/dashboard/dashboard.service.ts
git commit -m "feat(dashboard): expose loyalty and referral fields in getClientDetail"
```

---

## Task 8: Vérification de bout en bout

- [ ] **Step 1: Lancer la suite de tests complète**

Run: `npm test`
Expected: PASS — aucune régression, `admin.service.spec.ts` à 10 tests.

- [ ] **Step 2: Vérifier les 4 endpoints à la main**

Backend démarré, token ADMIN :

```bash
curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" "http://localhost:3000/admin/clients?search=a&limit=5"
curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" "http://localhost:3000/admin/clients/<ID>/loyalty"
curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" "http://localhost:3000/admin/clients/<ID>/referral"
curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" "http://localhost:3000/admin/payments"
```

Expected : chaque réponse est wrappée `{ data: ... }`, `/admin/clients` renvoie `loyaltyPoints` par client, `loyalty` renvoie `{ data: { balance, transactions }, total, page, limit }`, `referral` renvoie les 5 champs attendus, `payments` renvoie les paiements `PENDING` avec `order` + `user`.

- [ ] **Step 3: Vérifier le rejet d'un token non-ADMIN**

```bash
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer <CLIENT_TOKEN>" "http://localhost:3000/admin/payments"
```

Expected: `403`.

---

## Self-Review

**Couverture du périmètre backend (ticket LIL-79) :**
- Chantier 1 (Fidélité) backend : `getClientLoyalty` (Task 2) + `getClientDetail` enrichi (Task 7) ✅
- Chantier 2 (Parrainage) backend : `getClientReferral` (Task 3) + `getClientDetail` enrichi (Task 7) ✅
- Chantier 3 (Liste clients) backend : `getAllClients` étendu (Task 4) ✅
- Chantier 4 (Pages) backend : `getPendingPayments` (Task 5) ✅ — Livreurs (`GET /admin/deliverers`) et Zones (`/quartiers/*`) existent déjà, aucun ajout backend nécessaire.

**Hors périmètre de ce plan (volontaire) :** tout le frontend (`lilia-food-web`, `lilia-food-admin`) → plans séparés à venir une fois ces endpoints livrés.

**Cohérence des types :** `getClientLoyalty` → `{ data: { balance, transactions }, total, page, limit }` ; `getClientReferral` → `{ data: { referralCode, referredByCode, totalReferrals, convertedReferrals, referralBonusEarned } }` ; `getAllClients` / `getPendingPayments` → `{ data, total, page, limit }`. Noms identiques entre tests, implémentations et routes controller.
