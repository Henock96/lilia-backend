# Module backend `platform-settings` — Design

> Spec · 2026-05-22 · ticket LIL-79 (chantier 4, prérequis page Paramètres)

## Objectif

Créer un module backend qui centralise les paramètres économiques de la plateforme Lilia Food — aujourd'hui codés en dur dans le code — dans une configuration modifiable par l'admin. Les valeurs **pilotent réellement** le comportement : frais de service, économie de fidélité, bonus de parrainage, et un mode maintenance qui bloque la prise de commande.

Ce module est le prérequis backend de la page **Paramètres** de l'admin web (chantier 4 de LIL-79). Les 4 pages web feront l'objet d'un plan distinct.

## Contexte — constantes actuellement en dur

| Constante | Valeur | Emplacement |
|---|---|---|
| `SERVICE_FEE_RATE` | `0.08` | `orders/order-calculator.service.ts:5` |
| `POINTS_PER_100_FCFA` | `1` | `orders/orders.service.ts:51` |
| `POINT_VALUE_FCFA` | `5` | `orders/orders.service.ts:52` |
| `MIN_POINTS_REDEEM` | `100` | `orders/orders.service.ts:53` |
| `REFERRER_POINTS` | `500` | `orders/orders.service.ts:54` |
| `REFERRED_POINTS` | `200` | `orders/orders.service.ts:55` |

Ces valeurs deviennent les **valeurs par défaut** de la configuration. Tant que l'admin ne modifie rien, le comportement est strictement identique à aujourd'hui.

## Modèle de données

Un modèle Prisma `PlatformSettings` en **ligne unique** (singleton). L'id porte une valeur par défaut fixe, ce qui garantit qu'une seule ligne peut exister.

```prisma
model PlatformSettings {
  id                     String   @id @default("singleton")

  // Frais de service — pourcentage appliqué au sous-total
  serviceFeePercent      Float    @default(8)

  // Économie de fidélité
  loyaltyPointsPer100Xaf Int      @default(1)   // points gagnés par tranche de 100 XAF livrés
  loyaltyPointValueXaf   Int      @default(5)   // valeur d'1 point en XAF à l'utilisation
  loyaltyMinRedemption   Int      @default(100) // solde minimum pour utiliser des points

  // Bonus de parrainage (1ʳᵉ commande livrée du filleul)
  referrerBonusPoints    Int      @default(500)
  referredBonusPoints    Int      @default(200)

  // Mode maintenance
  maintenanceMode        Boolean  @default(false)
  maintenanceMessage     String?

  updatedAt              DateTime @updatedAt
}
```

**Création de la ligne** : pas de seed séparé. Le service la crée à la volée via `upsert` (`where id=singleton`, `create {}` — Prisma applique les `@default`). Idempotent et auto-réparateur si la ligne venait à manquer.

**Migration** : `npx prisma migrate dev --name add_platform_settings` — crée la table uniquement. Les commandes déjà passées conservent leur `serviceFee` figé ; changer le pourcentage n'affecte que les commandes futures.

## Structure du module

Nouveau dossier `apps/lilia-app/src/modules/platform-settings/` :

```
platform-settings/
  platform-settings.module.ts
  platform-settings.service.ts
  platform-settings.controller.ts
  platform-settings.service.spec.ts
  dto/update-platform-settings.dto.ts
  guards/maintenance.guard.ts
  guards/maintenance.guard.spec.ts
```

`PlatformSettingsModule` exporte `PlatformSettingsService` (consommé par `OrdersModule`, `DeliveriesModule`, et le module qui héberge `OrderCalculator`). `MaintenanceGuard` est exporté pour être posé sur la route checkout.

### `PlatformSettingsService`

- `getSettings(): Promise<PlatformSettings>` — cache mémoire avec TTL **60 s**. Au cache-miss : `upsert` de la ligne singleton, mise en cache, expiration = `now + 60_000`.
- `updateSettings(dto): Promise<PlatformSettings>` — `prisma.platformSettings.update` (PATCH partiel), **vide le cache** (la prochaine lecture refait l'aller-retour DB), retourne la ligne à jour.
- Le cache mémoire est par-instance ; le TTL de 60 s assure l'auto-réparation multi-instances Render (un PATCH se propage en ≤ 60 s).

### `PlatformSettingsController`

`@Controller('admin/platform-settings')`, `@Roles('ADMIN')` au niveau controller.

| Route | Description |
|---|---|
| `GET /admin/platform-settings` | Retourne la configuration — `{ data: PlatformSettings }` |
| `PATCH /admin/platform-settings` | Met à jour (partiel) — `{ data: PlatformSettings }` |

`UpdatePlatformSettingsDto` : tous les champs optionnels, validés via `class-validator` — `@IsNumber()` + `@IsPositive()`/`@Min()` pour les nombres, `@IsBoolean()` pour `maintenanceMode`, `@IsString() @IsOptional()` pour `maintenanceMessage`. `serviceFeePercent` borné `@Min(0) @Max(100)`.

## Câblage dans les chemins critiques

L'objectif : remplacer chaque constante par la valeur correspondante de `getSettings()`. Les constantes `static readonly` sont **supprimées**.

**`OrderCalculator` (frais de service)** — `calculate()` reçoit le pourcentage en **paramètre** : `calculate(..., serviceFeePercent: number)`. `OrderCalculator` reste une unité de calcul pure, sans nouvelle dépendance ni passage en async. L'appelant (`OrdersService`) récupère les settings une fois en début de checkout et passe `settings.serviceFeePercent`. `serviceFee = Math.round(subTotal * serviceFeePercent / 100)`. Le plan devra énumérer tous les appelants de `calculate()` et leur passer la valeur.

**`OrdersService`** — injecte `PlatformSettingsService`. En début de checkout, un seul `getSettings()`. Les valeurs alimentent : le calcul du gain de points (`loyaltyPointsPer100Xaf`), la réduction par points (`loyaltyPointValueXaf`, seuil `loyaltyMinRedemption`), et les bonus de parrainage (`referrerBonusPoints`, `referredBonusPoints`).

**`DeliveriesService`** — possède une copie de `awardLoyaltyPoints`. Injecte aussi `PlatformSettingsService` et lit `loyaltyPointsPer100Xaf`.

## Mode maintenance

`MaintenanceGuard` (`CanActivate`) posé via `@UseGuards(MaintenanceGuard)` sur la **seule** route `POST /orders/checkout` :

- Lit `getSettings()`. Si `maintenanceMode` est `false` → laisse passer.
- Si `true` : l'utilisateur **ADMIN** passe outre ; tout autre rôle reçoit `503 Service Unavailable` avec `maintenanceMessage` (ou un message par défaut si vide).
- Le rôle est lu sur l'utilisateur authentifié injecté par les guards globaux. Le plan précisera le mécanisme exact d'accès au rôle sur la requête checkout.

Les apps clientes existantes affichent déjà le `message` d'erreur backend au checkout — aucun changement client requis.

## Tests

- `platform-settings.service.spec.ts` (Jest, `PrismaService` mocké) — `getSettings` met en cache (2ᵉ appel sans requête DB), l'expiration du TTL déclenche un refetch, `updateSettings` vide le cache, l'`upsert` applique les défauts.
- `maintenance.guard.spec.ts` — bloque un non-admin quand `maintenanceMode` est actif, laisse passer l'admin, laisse tout passer quand le mode est inactif.

## Hors périmètre

- Les 4 pages web du chantier 4 (Paiements, Livreurs, Zones, Paramètres) → plan distinct.
- Affichage du statut maintenance dans les apps clientes (elles affichent déjà le message d'erreur du 503).
- Câblage du mode maintenance sur d'autres routes que le checkout.
- Historique / audit des modifications de configuration.
- Tiers de fidélité (Bronze/Argent/Or) → projet « Q1 2027 — Programme Fidélité Tiers ».

## Risque assumé

Le câblage touche les chemins critiques commande/fidélité/livraison. Mitigation : les `@default` du modèle = exactement les constantes actuelles, donc **zéro changement de comportement** tant que l'admin ne modifie pas la configuration. Les tests existants sur ces chemins (le cas échéant) et une vérification manuelle d'un checkout complet valident la non-régression.
