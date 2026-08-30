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

## Déploiement réel

```bash
node scripts/db/audit-orphans.js          # 1. re-vérifier l'état
node scripts/db/dry-run-fk-migration.js   # 2. répétition à blanc
npx prisma migrate deploy                 # 3. application (transactionnelle)
```

⚠️ L'étape 3 supprime les lignes orphelines listées ci-dessus. Elle est
irréversible sans restauration de sauvegarde — Neon conserve un historique
point-in-time, à vérifier avant de lancer.
