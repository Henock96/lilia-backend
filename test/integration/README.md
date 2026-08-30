# Tests d'intégration sur PostgreSQL réel

Ces tests existent parce que **les tests unitaires ne peuvent pas prouver ce
qu'ils prétendent prouver**.

Toute la suite backend mocke Prisma. Or les garanties les plus importantes du
système sont des garanties de **base de données** :

```sql
UPDATE "Product" SET "stockRestant" = "stockRestant" - 2
 WHERE id = $1 AND "stockRestant" >= 2      -- 0 ligne = stock épuisé
SELECT … FOR UPDATE                          -- sérialise les checkouts
@@unique([orderId, type])                    -- pas de double crédit fidélité
@@unique([deliveryId])                       -- une note par livraison
```

Un mock renvoie ce qu'on lui dit de renvoyer : il ne peut pas, par
construction, exhiber une race condition. Ces tests-là parlent à un vrai
PostgreSQL et exécutent réellement les requêtes en parallèle.

## Lancer

```bash
# Base dédiée, jamais celle de dev — les tests la vident entre chaque cas.
createdb lilia_integration_test

TEST_DATABASE_URL="postgresql://$USER@localhost:5432/lilia_integration_test" \
  npm run test:integration
```

Sans `TEST_DATABASE_URL`, la suite **se saute** au lieu d'échouer : un
développeur sans PostgreSQL local doit pouvoir lancer `npm test` sans voir des
erreurs rouges qui ne le concernent pas. La CI, elle, la définit.

## Ce qui est couvert

| Scénario | Garantie vérifiée |
|---|---|
| Deux checkouts concurrents, dernier article | `UPDATE … WHERE stockRestant >= qty` |
| Deux crédits de fidélité sur la même commande | `@@unique([orderId, type])` |
| Deux notes sur la même livraison | `@@unique([deliveryId])` |
| Deux lignes de panier identiques | index unique partiel `WHERE menuId IS NULL` |
| Deux acceptations de la même mission | `updateMany` conditionné sur le statut |

## Ce qui n'est pas couvert

Le parcours HTTP complet (guards, DTO, interceptors). Ces tests attaquent la
couche données directement : ils vérifient les garanties de concurrence, pas le
câblage de l'API — celui-ci est couvert par les tests unitaires.
