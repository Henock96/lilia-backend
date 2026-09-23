# Runbook d'exploitation — gestes sensibles et incidents d'argent

Mis en place avec la Phase 2 du Master Audit v1 (23/09/2026). Chaque section
correspond à une règle que le serveur applique désormais et au geste humain
qu'elle suppose.

---

## 1. Créer un administrateur (procédure « break-glass »)

**Pourquoi l'API le refuse.** `PATCH /admin/users/:id/role { role: ADMIN }`
répond 403 (F-08). Un seul compte ADMIN compromis pouvait sinon créer d'autres
administrateurs, qui survivaient à la révocation du premier.

**Procédure** (deux personnes : celle qui exécute, celle qui vérifie) :

1. La personne à promouvoir se connecte une fois à une application Lilia Food
   (sa ligne `User` existe) **avec un e-mail vérifié ou via Google**.
2. Vérifier la cible de la base AVANT toute écriture :
   `npm run db:target` — le `.env` du dépôt vise la production, la cascade
   locale peut viser `localhost` (voir la note sur la cascade d'environnement).
3. Depuis la console SQL de Neon (production) :
   ```sql
   UPDATE "User" SET role = 'ADMIN' WHERE email = '<email vérifié>' AND role <> 'ADMIN';
   ```
4. Tracer le geste à la main dans `AdminAuditLog` (action `USER_ROLE_CHANGED`,
   `metadata = {"newRole":"ADMIN","via":"break-glass"}`) et prévenir les autres
   administrateurs.
5. Le cache utilisateur expire en 5 minutes au plus.

**Rétrograder un administrateur compromis** : même chemin SQL
(`role = 'CLIENT'`), puis `PATCH /admin/users/:id/ban` depuis un autre compte
ADMIN pour désactiver le compte Firebase et révoquer ses sessions.

---

## 2. Compte de reversement d'un vendeur modifié

**Règle.** Après `PATCH /admin/vendors/:id/payout-account`, aucun virement ne
part vers ce vendeur avant `PAYOUT_ACCOUNT_COOLDOWN_HOURS` (24 h par défaut).
Le propriétaire reçoit un push ET un SMS annonçant le changement (F-08).

**Si le vendeur signale ne pas être à l'origine du changement** :
1. Remettre immédiatement l'ancien numéro (visible, masqué, dans le journal
   d'audit : action `VENDOR_PAYOUT_ACCOUNT_UPDATED`, champs `from` / `to`).
2. Identifier l'administrateur auteur (`actorId` de la même ligne), le bannir,
   révoquer ses sessions, puis rétrograder son compte (§ 1).
3. Vérifier qu'aucun `restaurant_payouts` n'est parti vers le numéro frauduleux
   pendant la fenêtre (il ne peut pas en partir pendant le délai de carence).

---

## 3. « Vendeur payé sur une commande annulée » (incident CRITICAL)

**Comment on y arrive.** Un ADMIN annule une commande alors que son reversement
est déjà parti chez pawaPay (un virement émis ne se rappelle pas). Le vendeur
ne peut plus, lui, annuler une commande reversée (409).

**Ce que fait le système.** Le remboursement client est ouvert (PENDING) mais
**son exécution est bloquée** tant que le reversement est PENDING ou SUCCESS.
À la confirmation du reversement, un incident CRITICAL « Vendeur payé sur une
commande annulée » est ouvert.

**Arbitrage** (une des deux voies, décidée et notée dans l'incident) :
- récupérer la somme auprès du vendeur, puis exécuter le remboursement ;
- rembourser le client à la charge de Lilia Food : virement manuel, puis
  `PATCH /refunds/:id/status { COMPLETED, notes }` (autorisé une fois le
  reversement SUCCESS, refusé tant qu'il est PENDING).

---

## 4. Preuve de remise (code client à 4 chiffres)

**Règle.** Au retrait du repas, un code est tiré et montré au client seul. Le
livreur le saisit pour conclure. 5 saisies maximum (la bonne comprise) ; au-delà
seul un ADMIN conclut (`handoverMethod = ADMIN_OVERRIDE`, audité).

**Mise en service en deux temps** (`DELIVERY_HANDOVER_CODE_REQUIRED`) :
1. `false` (défaut) : le code est vérifié s'il est fourni, sans être exigé.
   Déployer le backend, puis publier les apps livreur et client qui le gèrent.
2. Quand les apps livreur installées sont à jour : passer à `true`.

**Livreur bloqué (trop d'essais)** : appeler le client, confirmer la remise,
puis conclure depuis l'administration (`PATCH /deliveries/:id/status
{ status: LIVRER, reason }` par un ADMIN — le motif est obligatoire en pratique,
il est repris au journal d'audit).

**Client qui dit ne pas avoir reçu** : son signalement arrive comme incident
`WRONG_DELIVERY` / HIGH avec `handoverMethod` en métadonnée. `CODE` = le client
a donné son code ; `UNVERIFIED` = course conclue sans code (transition, ou
course antérieure) ; `ADMIN_OVERRIDE` = conclue par un administrateur.

---

## 5. Obligations durables (outbox) en échec

Les effets suivants sont écrits dans la transaction qui les crée et rejoués par
le worker : `order.delivered` (fidélité + parrainage), `order.refund_due`
(ouverture du remboursement), `order.expired` (prévenance client).

Surveiller :
```sql
SELECT type, status, attempts, "lastError", "createdAt"
  FROM "OutboxEvent"
 WHERE status = 'FAILED' OR (status = 'PENDING' AND attempts >= 3)
 ORDER BY "createdAt" DESC;
```
Un `order.refund_due` en FAILED signifie une dette client non ouverte : ouvrir
le remboursement à la main. Rejouer un événement : `UPDATE "OutboxEvent" SET
status = 'PENDING', attempts = 0, "nextAttemptAt" = now() WHERE id = '…'` —
tous ces effets sont idempotents.

---

## 6. Configuration de production à vérifier (non vérifiable depuis le code)

| Variable | Attendu | Pourquoi |
|---|---|---|
| `PAWAPAY_PUBLIC_KEY` | posée | signature RFC-9421 des webhooks ; sans elle, seule la liste d'IP authentifie |
| `PAYOUT_ACCOUNT_COOLDOWN_HOURS` | 24 (ou plus) | F-08 |
| `DELIVERY_HANDOVER_CODE_REQUIRED` | `false` puis `true` | § 4 |
| `REDIS_URL` | posée | idempotence du checkout, rate limiting, verrous de cron |
| `RUN_BACKGROUND_JOBS` | `true` sur le worker seul | outbox, expirations, réconciliation |
