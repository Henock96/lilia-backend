# Scripts base de données

Outils liés au passage de `relationMode = "prisma"` à `foreignKeys`
(migration `20260827120000_enable_foreign_keys`).

## `audit-orphans.js` — lecture seule

Exécute `prisma/scripts/audit-orphans.sql` : pour chacune des 45 relations du
schéma, compte les lignes dont le parent n'existe pas.

```bash
node scripts/db/audit-orphans.js
```

La session est ouverte en `default_transaction_read_only = on` : aucune écriture
n'est possible, même par accident.

À relancer **avant tout déploiement** de la migration : PostgreSQL refuse de
créer une contrainte tant qu'une seule ligne la viole.

Résultat de l'audit du 27/08/2026 sur la base de production :

| Relation | Orphelins |
|---|---|
| `Cart.userId → User.id` | 9 |
| `Adresses.userId → User.id` | 8 |
| `FcmToken.userId → User.id` | 5 |
| `Review.userId → User.id` | 1 |
| `VendorProfile.restaurantId → Restaurant.id` | 1 |

Toutes des traces de comptes de test supprimés. Les 9 paniers étaient vides,
aucune adresse n'était rattachée à une commande, et aucune table à valeur
comptable (`Order`, `OrderItem`, `payments`, `Delivery`) n'était touchée.

## `dry-run-fk-migration.js` — sans effet de bord

Joue l'intégralité de la migration dans une transaction **annulée à la fin**
(`ROLLBACK`). PostgreSQL valide réellement le nettoyage et les 45 contraintes,
mais la base ressort inchangée.

```bash
node scripts/db/dry-run-fk-migration.js
```

C'est la seule façon de savoir si `prisma migrate deploy` passera, sans le
jouer pour de bon. Dernier résultat : **45 contraintes créées en 706 ms**.

## `delete-vendor.js` — suppression physique d'un vendeur de test

Supprime un `Restaurant` **et tout ce qui en dépend** : commandes, items,
paiements, reversements, livraisons, avis, catalogue, promos. Réservé aux
vendeurs de test — pour un vendeur réel, la bonne opération est
`PATCH /admin/vendors/:id/suspend`.

```bash
node scripts/db/delete-vendor.js --list                 # inventaire, lecture seule
node scripts/db/delete-vendor.js <id>                   # répétition à blanc (ROLLBACK)
node scripts/db/delete-vendor.js <id> --commit          # suppression réelle
node scripts/db/delete-vendor.js <id> --commit --force  # outrepasse les garde-fous
node scripts/db/delete-vendor.js <id> --commit --with-owner
```

Sans `--commit`, tout est joué dans une transaction annulée : les décomptes
affichés sont ceux que PostgreSQL a réellement calculés, la base ressort
inchangée. Plusieurs ids peuvent être passés d'un coup.

**Garde-fous** (refus sauf `--force`) : commande non terminale, paiement
`SUCCESS`, reversement `PENDING`/`SUCCESS`. Un vendeur qui a encaissé de
l'argent n'est pas un vendeur de test.

**Ce que le script ne fait pas** — il l'affiche en fin d'exécution :
- **Cloudinary** : les `public_id` (logo, galerie, photos produits et menus)
  sont relevés **avant** suppression et listés ; après, ils sont introuvables ;
- **Firebase Auth** : le compte du propriétaire est à supprimer à la main ;
- **`AdminAuditLog`** : volontairement conservé — c'est un journal opposable en
  écriture seule, la trace doit survivre à la suppression.

`--with-owner` supprime le compte propriétaire, **avec repli en anonymisation**
(`SAVEPOINT`) quand il est en RESTRICT — journal d'audit, ou commandes passées
en tant que client. Mêmes champs que `UserDeletionService` (`DELETE /users/me`).

⚠️ **Deux pièges que l'ordre des `DELETE` traite** et qu'un `DELETE` manuel
raterait :
1. `PromoCode.restaurantId` est en **SET NULL** : sans suppression explicite,
   un code promo réservé au vendeur devient valable sur toute la plateforme ;
2. `PromoUsage`, `LoyaltyTransaction`, `OutboxEvent` et `Incident` portent un
   `orderId` / `restaurantId` en simple `String`, **hors relation Prisma** :
   rien ne les supprime, et `audit-orphans.js` ne les voit pas.

Validé de bout en bout sur une base PostgreSQL réelle avec une fixture couvrant
les 33 tables concernées : après `--commit`, seul `AdminAuditLog` subsiste.

## Déploiement réel

```bash
node scripts/db/audit-orphans.js          # 1. re-vérifier l'état
node scripts/db/dry-run-fk-migration.js   # 2. répétition à blanc
npx prisma migrate deploy                 # 3. application (transactionnelle)
```

⚠️ L'étape 3 supprime les lignes orphelines listées ci-dessus. Elle est
irréversible sans restauration de sauvegarde — Neon conserve un historique
point-in-time, à vérifier avant de lancer.
