# Fidélité & parrainage — règles, procédure, exploitation

**Refonte : 7 septembre 2026.** Ce document est la référence opératoire.
L'audit qui l'a motivée : `AUDIT_2026-09-06_fidelite_parrainage.md`.

---

## 1. Les règles, en une page

| | Règle |
|---|---|
| **Valeur d'un point** | `PlatformSettings.loyaltyPointValueXaf` — **50 FCFA** |
| **Gain de fidélité** | **forfait** `loyaltyPointsPerOrder` (1 pt) par commande **livrée**, quel que soit le montant |
| **Garde-fou anti-boucle** | une commande ayant consommé des points **n'en rapporte aucun** |
| **Utilisation** | à partir de `loyaltyMinRedemption` (1 pt), plafonnée au **panier alimentaire** |
| **Assiette** | `subTotal − promo`. Les points ne paient **ni la livraison ni les frais de service** |
| **Parrainage** | `referrerBonusPoints` (1 pt) au **parrain**, à la première commande **livrée** du filleul |
| **Filleul** | **0 point**. Le bonus de bienvenue a été supprimé |
| **Déclencheur unique** | `Order.status == LIVRER`, sur les deux chemins qui y mènent |

### Pourquoi `LIVRER` et pas `PAYER`

`LIVRER` est le **seul statut terminal** de `ORDER_TRANSITION_MATRIX`. Tout ce
qui le précède reste annulable avec remboursement — y compris `PAYER`, que le
vendeur peut annuler depuis `EN_PREPARATION` et `PRET`, et l'administrateur
depuis `EN_ROUTE`. Une récompense versée à `PAYER` devait donc ou bien être
reprise, ou bien être offerte. On préfère ne pas la verser trop tôt.

### Pourquoi le garde-fou anti-boucle

Un gain **forfaitaire** avec un point à 50 FCFA crée une machine perpétuelle :
une commande dont il reste au moins 50 FCFA de nourriture à payer convertit un
point en 50 FCFA de remise… et en rend un à la livraison. Le solde ne descend
jamais pendant que le client consomme.

L'ancienne règle proportionnelle (1 pt par 100 FCFA dépensés) fermait cette
boucle d'elle-même : on regagnait 5 % de ce qu'on dépensait, dépenser était
toujours perdant. Le forfait ne le fait pas, il faut donc l'écrire.

`LoyaltyService` lit `Order.loyaltyPointsUsed` **en base**, pas en paramètre :
un appelant ne peut pas se tromper sur une valeur qu'il ne fournit pas.

---

## 2. Où vit chaque décision

```
CHECKOUT                          order-checkout.service.ts
  useLoyaltyPoints: booléen — le client n'envoie JAMAIS de montant
  assiette = max(0, subTotal − promo)
  points   = min(solde, floor(assiette / loyaltyPointValueXaf))
  décrément CONDITIONNEL en transaction  (UPDATE … WHERE loyaltyPoints >= n)
  → Order.loyaltyPointsUsed / loyaltyDiscount  (snapshot, jamais recalculé)

LIVRAISON (2 chemins, mêmes services)
  order-lifecycle.service.ts:updateOrderStatusByRestaurateur
  deliveries.service.ts:updateStatus
     ├─ LoyaltyService.awardForDeliveredOrder(userId, orderId)
     │    idempotence : @@unique([orderId, ORDER_EARN])       ← la BASE arbitre
     └─ ReferralService.rewardForDeliveredOrder(userId, orderId)
          idempotence : ReferralReward.referredUserId @unique ← la BASE arbitre
          décision    : ReferralRiskService (score 0–100)

ANNULATION                        order-lifecycle.service.ts
  recrédit du solde NET des LoyaltyTransaction de la commande (idempotent)

SUPERVISION
  LoyaltyReconciliationService  cron 3h30 — SUM(ledger) == User.loyaltyPoints
  GET /admin/loyalty-drifts
```

---

## 3. Anti-abus du parrainage

**Principe : on n'interdit pas un comportement, on arbitre une récompense.**
La commande du filleul reste valide, livrée et facturée dans tous les cas ;
seul le point du parrain dépend du score.

| Score | Décision | Effet |
|---|---|---|
| 0–30 | `APPROVED` | point versé |
| 31–60 | `APPROVED` | versé, journalisé `REFERRAL_RISK_DETECTED` |
| 61–80 | `PENDING_REVIEW` | **0 pt** — file d'attente `/parrainages` |
| 81–100 | `REJECTED` | 0 pt, motif conservé |

Six signaux, pondérés, tous dans `users/referral-risk.config.ts` :

| Signal | Poids | Ce qu'il regarde |
|---|---|---|
| `DEVICE_SHARED` | 25 × n, max 50 | autres comptes sur la même installation |
| `PHONE_REUSED` | 65 | même numéro **normalisé** sur un autre compte |
| `NO_PHONE` | 15 | identité faible |
| `DEVICE_ACCOUNT_FARM` | 20 | ≥ 3 comptes nés de l'installation |
| `DEVICE_SAME_REFERRER` | 40 | l'installation a déjà converti un filleul du **même parrain** |
| `REFERRER_VELOCITY` | 20 | ≥ 3 récompenses au parrain sur 24 h |
| `DEVICE_BLOCKED` | 100 | installation bannie par un administrateur |

Plus le plafond dur `REFERRAL_MAX_REWARDS_PER_MONTH` (défaut 10), indépendant
du score.

### Ce qu'on ne fait surtout pas

**Refuser sur le seul partage d'appareil.** Un téléphone se prête, une famille
commande depuis la même tablette. `DEVICE_SHARED` seul vaut 25 — moitié moins
que le seuil de revue. Il faut un **second** signal pour retenir une récompense.

C'est la propriété que teste le cas E de `referral-risk.service.spec.ts`, et
c'est elle qui rend le système utilisable en production : un anti-fraude qui
n'échoue que dans le sens strict est facile à écrire et invivable.

### L'identifiant d'installation

UUID v4 généré par le client, persisté (`shared_preferences` / `localStorage`),
envoyé en `X-Lilia-Installation-Id`. **Aucune donnée matérielle** — ni IMEI, ni
MAC, ni numéro de série, ni empreinte de navigateur.

Il se réinitialise à la désinstallation et se partage avec le téléphone :
**c'est un signal, jamais une preuve**, et c'est exactement pourquoi il ne
décide jamais seul.

Capté au seul `POST /users/sync`, traversé par tous les modes de connexion
(e-mail, Google, Apple) à chaque ouverture de session.

### Observabilité

Journaux structurés, sans donnée personnelle :
`REFERRAL_REWARD_APPROVED` · `REFERRAL_REWARD_PENDING_REVIEW` ·
`REFERRAL_REWARD_REJECTED` · `REFERRAL_RISK_DETECTED` ·
`REFERRAL_DEVICE_REUSED` · `REFERRAL_PHONE_REUSED`.

---

## 4. ⚠️ PROCÉDURE DE DÉPLOIEMENT — ordre impératif

> La migration structurelle **ne change pas** la valeur du point. Le passage de
> 5 à 50 FCFA est fait par le script, **dans la même transaction** que la
> division des soldes. Les séparer multiplierait par dix tout le passif déjà
> distribué pendant l'intervalle.

### Avant le déploiement

```bash
# 1. Mesurer le passif réel. LECTURE SEULE — sans risque contre la production.
DATABASE_URL="<prod>" node scripts/db/redenominate-loyalty.js
#    → « Points en circulation », « Passif actuel », « Écart dû à l'arrondi »

# 2. Recenser les doublons de téléphone. LECTURE SEULE également.
DATABASE_URL="<prod>" node scripts/db/audit-phone-duplicates.js
```

### Le déploiement

```bash
# 3. Activer le mode maintenance (PATCH /admin/platform-settings, ou l'écran
#    « Paramètres » de l'administration). Il ferme la caisse : aucune commande
#    ne peut naître pendant la bascule, donc aucun point ne peut être gagné
#    entre la migration et la conversion — un point gagné dans cette fenêtre
#    serait divisé par dix et perdu.

# 4. Migration structurelle (Render la joue au déploiement).
npx prisma migrate deploy
#    Applique : colonnes, tables, index, et l'UPDATE qui pose
#    referrerBonusPoints = 1 / loyaltyMinRedemption = 1 / loyaltyPointsPerOrder = 1.
#    ⚠️ referrerBonusPoints DOIT passer à 1 ici : laissé à 500, le premier
#    filleul livré après le déploiement offrirait 500 points à son parrain.

# 5. Conversion des soldes + bascule du barème, atomique.
DATABASE_URL="<prod>" LILIA_ALLOW_PRODUCTION_WRITES=oui-je-sais-ce-que-je-fais \
  node scripts/db/redenominate-loyalty.js --commit

# 6. Vérifier : GET /admin/loyalty-drifts doit rendre une liste VIDE.
#    (Le script le vérifie déjà avant de valider et annule tout sinon.)

# 7. Désactiver le mode maintenance.
```

### Ce que fait le script, et ce qu'il ne fait pas

- **Atomique** — une transaction : soldes et barème basculent ensemble.
- **Idempotent** — deux gardes. La valeur du point doit valoir 5 (sinon refus),
  et tout compte portant déjà l'écriture `metadata.migration =
  'loyalty-redenomination-v1'` est ignoré.
- **Auditable** — une écriture `ADJUSTMENT` par compte portant le delta.
  Aucun `UPDATE` muet. C'est aussi ce qui préserve l'invariant
  `SUM(ledger) == loyaltyPoints` que la réconciliation contrôle chaque nuit.
- **Non destructif** — aucune ligne historique n'est supprimée ni réécrite.
- **`--dry-run` par défaut**, `ROLLBACK` systématique sans `--commit`.
- **Fail-closed** — `--commit` refuse toute base non locale sans
  `LILIA_ALLOW_PRODUCTION_WRITES`.

**Arrondi** : `round(ancien / 10)`. 10 → 1, 50 → 5, 100 → 10, 500 → 50, 15 → 2.
`floor` aurait retiré jusqu'à 45 FCFA de valeur à un client sans le prévenir ;
`round` peut en offrir jusqu'à 25. On préfère offrir.

**Vérifié le 07/09/2026** sur PostgreSQL local : simulation (rollback prouvé
inoffensif), exécution, rejeu refusé, rejeu forcé sans effet, invariant
solde/ledger à zéro écart.

---

## 5. Le téléphone — pourquoi `@unique` n'est pas encore posée

La réutilisation d'un numéro est le meilleur signal d'une ferme à comptes, et
l'unicité SQL serait la garde idéale. Elle est **inapplicable en l'état** : les
comptes historiques ont été créés avec `''` (chaîne vide), et `''` ne bénéficie
pas de l'échappatoire que PostgreSQL accorde à `NULL`. Créer l'index échouerait
sur l'existant, et la deuxième inscription sans téléphone échouerait ensuite en
409.

Trois temps, dont un seul est fait :

1. ✅ **Fait** — `POST /users/sync` écrit `NULL` et jamais `''` ; la migration
   `20260907120000` normalise l'existant.
2. ⏳ **À faire** — lancer `scripts/db/audit-phone-duplicates.js` contre la
   production et arbitrer les doublons trouvés. Le script ne supprime, ne
   fusionne et ne modifie rien : deux comptes partageant un numéro ne sont pas
   nécessairement une fraude (un parent qui inscrit son enfant, un commerçant
   et son employé).
3. ⏳ **Ensuite** — poser la contrainte :
   ```sql
   CREATE UNIQUE INDEX "User_phone_key" ON "User"(phone) WHERE phone IS NOT NULL;
   ```

En attendant, l'abus est fermé par le signal `PHONE_REUSED` (poids 65 → revue
humaine), qui compare sur la forme **normalisée** : `06 12 34 567`,
`+242 06 1234567` et `242061234567` sont le même numéro.

⚠️ `normalizePhone` (`users/phone.util.ts`) et la normalisation SQL du script
d'audit doivent rester alignées, sinon le rapport et le signal ne parlent plus
du même monde.

---

## 6. Administration

| Route | Rôle |
|---|---|
| `GET /admin/clients/:id/loyalty` | solde + historique (avec `type`, `orderId`, `sourceUserId`, `actorId`) |
| `GET /admin/clients/:id/referral` | code, parrain, filleuls, convertis |
| `POST /admin/clients/:id/loyalty/adjust` | **ajustement manuel tracé** — motif obligatoire |
| `GET /admin/referral-rewards?status=PENDING_REVIEW` | file d'arbitrage |
| `POST /admin/referral-rewards/:id/review` | approuver / refuser |
| `GET /admin/loyalty-drifts` | écarts solde ↔ ledger |
| `PATCH /admin/platform-settings` | barème — **journalisé** (`PLATFORM_SETTINGS_CHANGED`) |

**Aucun solde ne bouge sans nom.** Chaque ajustement porte son `actorId`, son
motif, et double sa trace dans `AdminAuditLog` avec l'avant/après. Un débit ne
peut pas rendre le solde négatif — décrément conditionné en base, comme au
checkout.

Seul un `PENDING_REVIEW` est révisable : approuver un refus motivé reviendrait
à le contourner sans le rouvrir, et rejouer une approbation doublerait un crédit
déjà passé.

### ⚠️ `loyaltyPointValueXaf` dans le back-office

C'est le seul réglage à **effet rétroactif** de l'écran. Les deux
administrations affichent un avertissement sous le champ. Le modifier sans
exécuter la procédure du §4 multiplie instantanément le passif de la plateforme.

---

## 7. Notifications

Émises **hors** de la transaction financière — un échec FCM ne doit jamais
annuler un crédit de points. L'idempotence du crédit protège du même coup celle
de la notification : le second passage n'écrit rien, donc n'émet rien.

| Événement | Destinataire | Message |
|---|---|---|
| `loyalty.points.earned` | client | « +1 point de fidélité — 50 FCFA de réduction » |
| `referral.reward.granted` | **parrain seul** | « Votre filleul a passé sa première commande » |

Aucun montant n'est écrit en dur : la valeur du point voyage dans l'événement,
telle qu'elle était au moment du crédit.

L'utilisation des points n'a **pas** de notification dédiée : elle apparaît
dans la confirmation de commande, où le client la voit au moment où elle le
concerne.

---

## 8. Ce qu'aucun client ne doit jamais faire

1. **Multiplier des points par une constante.** Le seul chemin autorisé est
   `PlatformSettings` : `settings.pointsToXaf(n)` (Flutter, admin Flutter),
   `pointsToXaf(n, pricing)` (web).
2. **Envoyer un montant, un nombre de points ou une remise.** Le client
   n'envoie que l'intention `useLoyaltyPoints: true`.
3. **Recalculer une règle métier financière.** `CheckoutEstimate` (Flutter) et
   `computeCheckoutEstimate` (web) sont des **miroirs** d'affichage : ils
   consomment des valeurs serveur et les recomposent dans le même ordre. Le
   total facturé reste celui calculé au checkout.
4. **Porter une logique anti-fraude.** Un client est modifiable par qui le fait
   tourner. Le backend décide.
