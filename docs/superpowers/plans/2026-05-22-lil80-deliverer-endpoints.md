# LIL-80 Backend — Endpoints détail livreur — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter au backend deux endpoints ADMIN qui alimentent la fiche livreur et le suivi de mission de l'app admin (LIL-80) : détail d'un livreur (identité, stats, mission en cours) et historique paginé de ses livraisons.

**Architecture:** NestJS monorepo (`apps/lilia-app`). Deux méthodes ajoutées à `AdminService` (requêtes Prisma sur `Delivery`), deux routes sur `AdminController` (`@Controller('admin') @Roles('ADMIN')`). TDD via Jest avec mock Prisma, sur le pattern existant de `admin.service.spec.ts`.

**Tech Stack:** NestJS, Prisma, Jest. Vérification : `npm test -- admin.service.spec.ts`, `npm run lint`, `npm run build`.

**Périmètre :** Volet backend de LIL-80 (volet Flutter = plan distinct, `lilia-food-admin`). Prérequis du volet Flutter.

---

## Contexte du code existant

- `AdminController` (`apps/lilia-app/src/modules/admin/admin.controller.ts`) : `@Controller('admin') @Roles('ADMIN')`, guards globaux actifs. Section `// ─── LIVREURS ───` avec déjà `@Get('deliverers')`. Importe déjà `ApiParam`, `ApiQuery`, `ApiOperation`.
- `AdminService` (`admin.service.ts`) : méthodes Prisma. `getAllDeliverers(page, limit)` est à la ligne ~331 ; les nouvelles méthodes se placent juste après.
- `admin.service.spec.ts` : tests Jest avec un helper `createPrismaMock()` typé `PrismaMock` (entités `user`, `loyaltyTransaction`, `payment`). Module de test : `Test.createTestingModule({ providers: [AdminService, { provide: PrismaService, useValue: prisma }] })`.
- **Modèle `Delivery`** : `id`, `orderId` (unique), `delivererId?`, `status: DeliveryStatus`, `createdAt`, `updatedAt`, `estimatedArrival?`, `pickedUpAt?`, `deliveredAt?`, `lastLatitude?`, `lastLongitude?`, `lastPositionAt?`. Relation `order: Order`.
- **`enum DeliveryStatus`** : `EN_ATTENTE`, `ASSIGNER`, `EN_TRANSIT`, `LIVRER`, `ECHEC`. Mission « en cours » = statut `ASSIGNER` ou `EN_TRANSIT` ; `LIVRER` = livrée ; `ECHEC` = échec.
- **`Order`** : `status`, `deliveryAddress?`, `deliveryLatitude?`, `deliveryLongitude?`, `total`, relation `restaurant`.
- **`Restaurant`** : `nom`, `adresse`, `latitude?`, `longitude?`.
- Le suivi temps réel (`/tracking`, `assertCanWatchOrder`) autorise **déjà** le rôle `ADMIN` — aucune modification du tracking n'est nécessaire.
- Réponses : `getAllDeliverers` renvoie `{ data, total, page, limit }` ; `getPendingPayments` idem. Les méthodes « détail » renvoient `{ data: {...} }`.

---

## File Structure

| Fichier | Rôle | Action |
|---|---|---|
| `apps/lilia-app/src/modules/admin/admin.service.ts` | `getDelivererDetail`, `getDelivererDeliveries` | Modifier |
| `apps/lilia-app/src/modules/admin/admin.service.spec.ts` | Mock Prisma étendu + tests des 2 méthodes | Modifier |
| `apps/lilia-app/src/modules/admin/admin.controller.ts` | 2 routes `GET /admin/deliverers/:id[/deliveries]` | Modifier |

---

## Task 1: `getDelivererDetail` — détail livreur, stats, mission en cours

**Files:**
- Modify: `apps/lilia-app/src/modules/admin/admin.service.spec.ts`
- Modify: `apps/lilia-app/src/modules/admin/admin.service.ts`

- [ ] **Step 1: Étendre le mock Prisma**

Dans `admin.service.spec.ts`, le type `PrismaMock` et `createPrismaMock()` n'ont pas l'entité `delivery`. Ajouter-la.

Remplacer le type `PrismaMock` :

```typescript
type PrismaMock = {
  user: { findUnique: jest.Mock; findMany: jest.Mock; count: jest.Mock };
  loyaltyTransaction: { findMany: jest.Mock; count: jest.Mock; aggregate: jest.Mock };
  payment: { findMany: jest.Mock; count: jest.Mock };
};
```

par :

```typescript
type PrismaMock = {
  user: { findUnique: jest.Mock; findMany: jest.Mock; count: jest.Mock };
  loyaltyTransaction: { findMany: jest.Mock; count: jest.Mock; aggregate: jest.Mock };
  payment: { findMany: jest.Mock; count: jest.Mock };
  delivery: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    groupBy: jest.Mock;
  };
};
```

Et remplacer `createPrismaMock()` :

```typescript
function createPrismaMock(): PrismaMock {
  return {
    user: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    loyaltyTransaction: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    payment: { findMany: jest.fn(), count: jest.fn() },
  };
}
```

par :

```typescript
function createPrismaMock(): PrismaMock {
  return {
    user: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    loyaltyTransaction: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    payment: { findMany: jest.fn(), count: jest.fn() },
    delivery: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
  };
}
```

- [ ] **Step 2: Écrire les tests qui échouent**

Ajouter ce bloc `describe` dans `admin.service.spec.ts`, avant l'accolade fermante du `describe('AdminService')` racine :

```typescript
  describe('getDelivererDetail', () => {
    it('renvoie identité, stats et mission en cours', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'd1',
        email: 'livreur@lilia.cg',
        nom: 'Livreur Un',
        phone: '+242000000',
        imageUrl: null,
        createdAt: new Date('2026-01-01'),
        role: 'LIVREUR',
      });
      prisma.delivery.groupBy.mockResolvedValue([
        { status: 'LIVRER', _count: 7 },
        { status: 'EN_TRANSIT', _count: 1 },
        { status: 'ECHEC', _count: 2 },
      ]);
      prisma.delivery.findFirst.mockResolvedValue({
        id: 'dl1',
        orderId: 'o1',
        status: 'EN_TRANSIT',
        estimatedArrival: new Date('2026-05-22T12:00:00Z'),
        lastLatitude: -4.26,
        lastLongitude: 15.24,
        lastPositionAt: new Date('2026-05-22T11:50:00Z'),
        order: {
          status: 'EN_LIVRAISON',
          deliveryAddress: 'Bacongo, Brazzaville',
          deliveryLatitude: -4.28,
          deliveryLongitude: 15.25,
          restaurant: {
            nom: 'Chez Lilia',
            adresse: 'Centre-ville',
            latitude: -4.25,
            longitude: 15.23,
          },
        },
      });

      const result = await service.getDelivererDetail('d1');

      expect(result.data.id).toBe('d1');
      expect(result.data.stats).toEqual({
        total: 10,
        delivered: 7,
        failed: 2,
        inProgress: 1,
      });
      expect(result.data.currentMission).toMatchObject({
        orderId: 'o1',
        deliveryId: 'dl1',
        deliveryStatus: 'EN_TRANSIT',
        orderStatus: 'EN_LIVRAISON',
        restaurant: {
          nom: 'Chez Lilia',
          latitude: -4.25,
          longitude: 15.23,
        },
        deliveryLatitude: -4.28,
        lastLatitude: -4.26,
      });
      const groupArgs = prisma.delivery.groupBy.mock.calls[0][0];
      expect(groupArgs.where).toEqual({ delivererId: 'd1' });
      const missionArgs = prisma.delivery.findFirst.mock.calls[0][0];
      expect(missionArgs.where).toEqual({
        delivererId: 'd1',
        status: { in: ['ASSIGNER', 'EN_TRANSIT'] },
      });
    });

    it('renvoie currentMission = null si aucune livraison en cours', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'd2',
        email: null,
        nom: 'Livreur Deux',
        phone: null,
        imageUrl: null,
        createdAt: new Date('2026-01-01'),
        role: 'LIVREUR',
      });
      prisma.delivery.groupBy.mockResolvedValue([]);
      prisma.delivery.findFirst.mockResolvedValue(null);

      const result = await service.getDelivererDetail('d2');

      expect(result.data.currentMission).toBeNull();
      expect(result.data.stats).toEqual({
        total: 0,
        delivered: 0,
        failed: 0,
        inProgress: 0,
      });
    });

    it('lève NotFoundException si l\'utilisateur n\'est pas un livreur', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        role: 'CLIENT',
      });

      await expect(service.getDelivererDetail('u1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
```

- [ ] **Step 3: Lancer les tests pour vérifier qu'ils échouent**

Run: `cd /Users/henokmipoks/Desktop/code/lilia-backend && npm test -- admin.service.spec.ts`
Expected: FAIL — `service.getDelivererDetail` n'existe pas.

- [ ] **Step 4: Implémenter `getDelivererDetail`**

Dans `admin.service.ts`, juste après la méthode `getAllDeliverers`, ajouter :

```typescript
  /**
   * Détail d'un livreur : identité, statistiques de livraisons et mission
   * en cours (Delivery au statut ASSIGNER ou EN_TRANSIT, la plus récente).
   */
  async getDelivererDetail(delivererId: string) {
    const deliverer = await this.prisma.user.findUnique({
      where: { id: delivererId },
      select: {
        id: true,
        email: true,
        nom: true,
        phone: true,
        imageUrl: true,
        createdAt: true,
        role: true,
      },
    });
    if (!deliverer || deliverer.role !== 'LIVREUR') {
      throw new NotFoundException('Livreur introuvable');
    }

    const grouped = await this.prisma.delivery.groupBy({
      by: ['status'],
      where: { delivererId },
      _count: true,
    });
    const countOf = (status: string) =>
      grouped.find((g) => g.status === status)?._count ?? 0;
    const stats = {
      total: grouped.reduce((sum, g) => sum + (g._count ?? 0), 0),
      delivered: countOf('LIVRER'),
      failed: countOf('ECHEC'),
      inProgress: countOf('ASSIGNER') + countOf('EN_TRANSIT'),
    };

    const mission = await this.prisma.delivery.findFirst({
      where: { delivererId, status: { in: ['ASSIGNER', 'EN_TRANSIT'] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderId: true,
        status: true,
        estimatedArrival: true,
        lastLatitude: true,
        lastLongitude: true,
        lastPositionAt: true,
        order: {
          select: {
            status: true,
            deliveryAddress: true,
            deliveryLatitude: true,
            deliveryLongitude: true,
            restaurant: {
              select: {
                nom: true,
                adresse: true,
                latitude: true,
                longitude: true,
              },
            },
          },
        },
      },
    });

    const currentMission = mission
      ? {
          orderId: mission.orderId,
          deliveryId: mission.id,
          deliveryStatus: mission.status,
          orderStatus: mission.order.status,
          restaurant: {
            nom: mission.order.restaurant?.nom ?? null,
            adresse: mission.order.restaurant?.adresse ?? null,
            latitude: mission.order.restaurant?.latitude ?? null,
            longitude: mission.order.restaurant?.longitude ?? null,
          },
          deliveryAddress: mission.order.deliveryAddress,
          deliveryLatitude: mission.order.deliveryLatitude,
          deliveryLongitude: mission.order.deliveryLongitude,
          estimatedArrival: mission.estimatedArrival,
          lastLatitude: mission.lastLatitude,
          lastLongitude: mission.lastLongitude,
          lastPositionAt: mission.lastPositionAt,
        }
      : null;

    return {
      data: {
        id: deliverer.id,
        email: deliverer.email,
        nom: deliverer.nom,
        phone: deliverer.phone,
        imageUrl: deliverer.imageUrl,
        createdAt: deliverer.createdAt,
        stats,
        currentMission,
      },
    };
  }
```

Vérifier que `NotFoundException` est bien importé en tête de `admin.service.ts` (depuis `@nestjs/common`). S'il ne l'est pas, l'ajouter à l'import existant.

- [ ] **Step 5: Lancer les tests pour vérifier qu'ils passent**

Run: `cd /Users/henokmipoks/Desktop/code/lilia-backend && npm test -- admin.service.spec.ts`
Expected: PASS — les 3 tests `getDelivererDetail` passent, les tests préexistants restent verts.

- [ ] **Step 6: Commit**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend
git add apps/lilia-app/src/modules/admin/admin.service.ts apps/lilia-app/src/modules/admin/admin.service.spec.ts
git commit -m "feat(admin): add getDelivererDetail service method"
```

---

## Task 2: `getDelivererDeliveries` — historique paginé

**Files:**
- Modify: `apps/lilia-app/src/modules/admin/admin.service.spec.ts`
- Modify: `apps/lilia-app/src/modules/admin/admin.service.ts`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter ce bloc `describe` dans `admin.service.spec.ts`, avant l'accolade fermante du `describe('AdminService')` racine :

```typescript
  describe('getDelivererDeliveries', () => {
    it('renvoie les livraisons paginées du livreur', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'd1', role: 'LIVREUR' });
      prisma.delivery.findMany.mockResolvedValue([
        {
          id: 'dl1',
          orderId: 'o1',
          status: 'LIVRER',
          createdAt: new Date('2026-05-20'),
          deliveredAt: new Date('2026-05-20'),
          order: {
            id: 'o1',
            total: 9000,
            status: 'LIVRER',
            deliveryAddress: 'Bacongo',
            restaurant: { nom: 'Chez Lilia' },
          },
        },
      ]);
      prisma.delivery.count.mockResolvedValue(1);

      const result = await service.getDelivererDeliveries('d1', 1, 20);

      expect(result).toEqual({
        data: [
          {
            id: 'dl1',
            orderId: 'o1',
            status: 'LIVRER',
            createdAt: new Date('2026-05-20'),
            deliveredAt: new Date('2026-05-20'),
            order: {
              id: 'o1',
              total: 9000,
              status: 'LIVRER',
              deliveryAddress: 'Bacongo',
              restaurant: { nom: 'Chez Lilia' },
            },
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
      });
      const args = prisma.delivery.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ delivererId: 'd1' });
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      expect(args.skip).toBe(0);
      expect(args.take).toBe(20);
    });

    it('applique la pagination (page 2)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'd1', role: 'LIVREUR' });
      prisma.delivery.findMany.mockResolvedValue([]);
      prisma.delivery.count.mockResolvedValue(40);

      const result = await service.getDelivererDeliveries('d1', 2, 20);

      expect(result.page).toBe(2);
      expect(result.total).toBe(40);
      const args = prisma.delivery.findMany.mock.calls[0][0];
      expect(args.skip).toBe(20);
    });

    it('lève NotFoundException si l\'utilisateur n\'est pas un livreur', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });

      await expect(
        service.getDelivererDeliveries('u1', 1, 20),
      ).rejects.toThrow(NotFoundException);
    });
  });
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `cd /Users/henokmipoks/Desktop/code/lilia-backend && npm test -- admin.service.spec.ts`
Expected: FAIL — `service.getDelivererDeliveries` n'existe pas.

- [ ] **Step 3: Implémenter `getDelivererDeliveries`**

Dans `admin.service.ts`, juste après `getDelivererDetail`, ajouter :

```typescript
  /**
   * Historique paginé des livraisons d'un livreur, de la plus récente
   * à la plus ancienne.
   */
  async getDelivererDeliveries(delivererId: string, page = 1, limit = 20) {
    const deliverer = await this.prisma.user.findUnique({
      where: { id: delivererId },
      select: { id: true, role: true },
    });
    if (!deliverer || deliverer.role !== 'LIVREUR') {
      throw new NotFoundException('Livreur introuvable');
    }

    const where = { delivererId };
    const [deliveries, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          orderId: true,
          status: true,
          createdAt: true,
          deliveredAt: true,
          order: {
            select: {
              id: true,
              total: true,
              status: true,
              deliveryAddress: true,
              restaurant: { select: { nom: true } },
            },
          },
        },
      }),
      this.prisma.delivery.count({ where }),
    ]);

    return { data: deliveries, total, page, limit };
  }
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `cd /Users/henokmipoks/Desktop/code/lilia-backend && npm test -- admin.service.spec.ts`
Expected: PASS — les 3 tests `getDelivererDeliveries` passent, aucune régression.

- [ ] **Step 5: Commit**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend
git add apps/lilia-app/src/modules/admin/admin.service.ts apps/lilia-app/src/modules/admin/admin.service.spec.ts
git commit -m "feat(admin): add getDelivererDeliveries service method"
```

---

## Task 3: Routes du contrôleur

**Files:**
- Modify: `apps/lilia-app/src/modules/admin/admin.controller.ts`

- [ ] **Step 1: Ajouter les 2 routes**

Dans `admin.controller.ts`, section `// ─── LIVREURS ───`, juste après le bloc de la route `@Get('deliverers')` (méthode `getAllDeliverers`), ajouter :

```typescript
  @Get('deliverers/:id')
  @ApiOperation({
    summary: 'Détail d\'un livreur : stats + mission en cours',
  })
  @ApiParam({ name: 'id', description: 'ID du livreur' })
  getDelivererDetail(@Param('id') id: string) {
    return this.adminService.getDelivererDetail(id);
  }

  @Get('deliverers/:id/deliveries')
  @ApiOperation({ summary: 'Historique paginé des livraisons d\'un livreur' })
  @ApiParam({ name: 'id', description: 'ID du livreur' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getDelivererDeliveries(
    @Param('id') id: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.adminService.getDelivererDeliveries(
      id,
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }
```

`Param`, `Query`, `Get`, `ApiOperation`, `ApiParam`, `ApiQuery` sont déjà importés dans ce fichier (utilisés par les routes existantes) — ne rien ajouter aux imports.

- [ ] **Step 2: Vérifier le lint et la compilation**

Run: `cd /Users/henokmipoks/Desktop/code/lilia-backend && npm run lint && npm run build`
Expected: lint sans erreur, build réussi.

- [ ] **Step 3: Commit**

```bash
cd /Users/henokmipoks/Desktop/code/lilia-backend
git add apps/lilia-app/src/modules/admin/admin.controller.ts
git commit -m "feat(admin): expose GET /admin/deliverers/:id and /:id/deliveries"
```

---

## Task 4: Vérification finale

- [ ] **Step 1: Suite de tests unitaires admin**

Run: `cd /Users/henokmipoks/Desktop/code/lilia-backend && npm test -- admin.service.spec.ts`
Expected: PASS — tous les tests (préexistants + `getDelivererDetail` + `getDelivererDeliveries`).

- [ ] **Step 2: Lint + build complet**

Run: `cd /Users/henokmipoks/Desktop/code/lilia-backend && npm run lint && npm run build`
Expected: aucune erreur.

- [ ] **Step 3: Vérification manuelle (si l'environnement le permet)**

Avec un token Firebase ADMIN, sur l'instance locale ou déployée :
- `GET /admin/deliverers/:id` (id d'un livreur existant) → `200`, objet `{ data: { id, ..., stats, currentMission } }`.
- `GET /admin/deliverers/:id/deliveries?page=1&limit=20` → `200`, `{ data: [...], total, page, limit }`.
- `GET /admin/deliverers/<id-inexistant>` → `404`.
- Avec un token non-ADMIN → `403` (guard de rôle).

---

## Self-Review

**Couverture du spec (volet backend de §4.1) :**
- `GET /admin/deliverers/:id` → identité + `stats` + `currentMission` : Task 1 + Task 3 ✅
- `GET /admin/deliverers/:id/deliveries?page&limit` → historique paginé : Task 2 + Task 3 ✅
- Mission « en cours » = `Delivery` au statut `ASSIGNER`/`EN_TRANSIT`, la plus récente : Task 1 (`findFirst` + `orderBy createdAt desc`) ✅
- `404` livreur introuvable / cas « aucune livraison » (stats à 0, `currentMission` null) : Task 1 (tests 2 et 3) ✅
- Autorisation admin sur `/tracking` : **aucune modification nécessaire** — `assertCanWatchOrder` autorise déjà `role === 'ADMIN'` (vérifié à l'exploration). Pas de tâche.

**Écart spec assumé :** le spec §4.1 nommait la statistique `cancelled` ; l'enum `DeliveryStatus` n'a pas de statut « annulé » mais `ECHEC`. La stat est donc nommée `failed` (compte les `ECHEC`). Le volet Flutter l'affichera en « Échecs ».

**Cohérence des types :** `getDelivererDetail` → `{ data: { id, email, nom, phone, imageUrl, createdAt, stats, currentMission } }` avec `stats: { total, delivered, failed, inProgress }` et `currentMission` (objet ou `null`) tel que défini en Task 1 — c'est le contrat que le volet Flutter consommera. `getDelivererDeliveries` → `{ data: Delivery[], total, page, limit }`, chaque item `{ id, orderId, status, createdAt, deliveredAt, order: { id, total, status, deliveryAddress, restaurant: { nom } } }`. Les noms de méthodes (`getDelivererDetail`, `getDelivererDeliveries`) sont identiques entre service (Tasks 1-2) et contrôleur (Task 3).

**Placeholders :** aucun — code complet à chaque étape.

**Note pour le volet Flutter :** le contrat de réponse ci-dessus (`currentMission` et l'item d'historique) doit être repris tel quel par les modèles Dart du plan `lilia-food-admin`.
