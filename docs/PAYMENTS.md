# Paiements & reversements — Lilia Food

**Encaisser le client et payer le vendeur sont deux mouvements d'argent
distincts, à deux moments différents, décidés par deux acteurs différents.**

Tout ce document découle de cette phrase.

```
CLIENT ──6 400 F──▶ pawaPay ──▶ Lilia Food        (COLLECTION, automatique)
                                     │
                                     │ … la commande est préparée …
                                     │
                                ┌────▼────┐
                                │  ADMIN  │  ← décision humaine
                                └────┬────┘
                                     │
Lilia Food ──4 500 F──▶ pawaPay ──▶ VENDEUR       (PAYOUT, manuel)
```

---

## 1. Les quatre flux d'argent, et pourquoi on ne les mélange jamais

| Flux | Qui paie | Qui reçoit | Colonne | Calculé sur |
|---|---|---|---|---|
| **Frais de service client** | Client, **en plus** du panier | Lilia Food | `Order.serviceFee` | `subTotal × PlatformSettings.serviceFeePercent` (8 %) |
| **Commission vendeur** | Vendeur, **retenue** sur son dû | Lilia Food | `RestaurantPayout.commissionAmount` | `subTotal × commissionPercent` (10 % par défaut) |
| **Frais d'encaissement** | Lilia Food | Prestataire | `Payment.collectionFeeXaf` | facturé par pawaPay |
| **Frais de reversement** | Lilia Food | Prestataire | `RestaurantPayout.payoutFeeXaf` | facturé par pawaPay |

**Les deux premiers sont des revenus, les deux derniers des charges.** Les frais
du prestataire ne sont **jamais** déduits de ce que touche le vendeur : c'est le
coût d'exploitation de Lilia Food, pas une retenue sur le commerçant.

### Exemple complet

```
Produits                       5 000 F
+ Livraison                    1 000 F
+ Frais de service (8 %)         400 F
──────────────────────────────────────
  LE CLIENT PAIE               6 400 F   →  encaissé par pawaPay

Montant produits               5 000 F
− Commission (10 %)              500 F
──────────────────────────────────────
  LE VENDEUR REÇOIT            4 500 F   →  reversé par pawaPay

Frais de service                 400 F
+ Commission                     500 F
− Frais encaissement               ~ F   (charge)
− Frais reversement                ~ F   (charge)
──────────────────────────────────────
  MARGE LILIA FOOD
```

> ⚠️ Ni les **frais de livraison**, ni la **remise** (code promo, points de
> fidélité), ni les **frais de service** n'entrent dans le calcul du reversement.
> La remise en particulier : c'est une opération commerciale de Lilia Food, et
> la déduire ferait payer au vendeur une campagne qu'il n'a pas décidée. Ce
> choix vit dans `money.util.ts#computePayoutBreakdown` et y est verrouillé par
> les tests.

### Où se configurent les taux

| Taux | Où | Portée |
|---|---|---|
| Frais de service client | `PlatformSettings.serviceFeePercent` | plateforme |
| Commission vendeur, défaut | `PlatformSettings.restaurantCommissionPercent` | plateforme |
| Commission vendeur, surcharge | `Restaurant.commissionPercent` | un vendeur |

**Aucun taux n'est écrit en dur.** Restaurant A à 10 %, B à 8 %, C à 12 % se
règle sans déploiement. Le taux appliqué est **figé sur chaque reversement**
(`RestaurantPayout.commissionPercent`) : le passer de 10 % à 12 % demain ne
réécrit pas ce qui a été prélevé hier.

---

## 2. Architecture

```
PaymentController          AdminPayoutController      PawaPayWebhookController
       │                            │                    │           │
       ▼                            ▼                    ▼           ▼
 PaymentService            RestaurantPayoutService   (deposits)  (payouts)
       │                            │                    │           │
       │  applyCollectionProviderStatus()  ◀─────────────┘           │
       │  applyPayoutProviderStatus()      ◀─────────────────────────┘
       │                            │
       └────────────┬───────────────┘
                    ▼
         PaymentProviderRegistry          ← PAYMENT_MODE
        ┌───────────┼────────────┐
        ▼           ▼            ▼
 ManualProvider  MtnMomoProvider  PawaPayProvider
                                       │
                                  PawaPayHttpService
                                  PawaPaySignatureService
```

**Deux règles de conception :**

1. **Un provider parle au prestataire, il ne décide de rien.** Ni transition de
   commande, ni événement, ni notification. Remplacer pawaPay ne devrait toucher
   qu'un dossier.
2. **Un seul point de transition par flux.** `applyCollectionProviderStatus` et
   `applyPayoutProviderStatus` sont appelés par le webhook, par l'interrogation
   du client **et** par le cron de réconciliation. Trois implémentations de la
   même décision finiraient par produire trois résultats différents.

---

## 3. Encaissement (collection)

```
POST /orders/checkout            Order EN_ATTENTE, stock réservé, panier vidé
        │                        ⚠️ le vendeur n'est PAS notifié
        ▼
POST /payments                   Payment PENDING + depositId (UUIDv4)
        │                        ↳ persisté AVANT l'appel réseau
        ▼
POST /v2/deposits (pawaPay)      → ACCEPTED
        ▼
  📱 demande sur le téléphone du client
        │
   ┌────┴─────┐
   ▼          ▼
COMPLETED   FAILED
   │          │
   ▼          ▼
Order PAYER   Order INCHANGÉE (reste payable)
outbox order.paid → 🔔 vendeur
```

### Ce qui rend le double débit impossible

| # | Défense | Où | Prouvé par |
|---|---|---|---|
| 1 | `depositId` **généré par nous** et stocké **avant** l'appel — un rejeu renvoie `DUPLICATE_IGNORED` | `PaymentService.acquireOrReusePendingPayment` | `payment-collection.spec` |
| 2 | Index unique partiel `payments(orderId) WHERE status='PENDING'` — la **base** arbitre le double clic, pas un `if` | migration `payment_unique_indexes` | `payments.int-spec` (PostgreSQL réel) |
| 3 | Index unique `(provider, providerTransactionId)` — le webhook ne peut pas trouver deux paiements | idem | `payments.int-spec` |
| 4 | `payment.updateMany WHERE status='PENDING'` — le premier statut terminal gagne | `applyCollectionProviderStatus` | `payment-transitions.spec` + `payments.int-spec` |
| 5 | `order.updateMany WHERE status='EN_ATTENTE'` — pas de résurrection de commande annulée | idem (fix H2) | `payment-transitions.spec` |
| 6 | Plafond `PAYMENT_MAX_ATTEMPTS` (3) | `assertAttemptsRemaining` | `payment-collection.spec` |

⚠️ **L'index #2 est partiel, celui des reversements ne l'est pas.**
`payments(orderId) WHERE status='PENDING'` laisse ouvrir une nouvelle tentative
après un échec ; `restaurant_payouts.orderId` est unique **sans condition**.
C'est pour cela que `retryPayout` **supprime** la ligne échouée au lieu d'en
insérer une seconde. Traiter les deux de la même façon casserait l'un ou
l'autre.

### Matrice de transitions réellement appliquée

Elle n'est portée par aucune table de constantes côté encaissement : elle
découle des `updateMany` conditionnés. La voici, telle que
`payment-transitions.spec.ts` la vérifie cas par cas.

| Depuis | Vers | Résultat |
|---|---|---|
| `PENDING` | `SUCCESS` | appliqué — commande `PAYER`, outbox `order.paid` |
| `PENDING` | `FAILED` | appliqué — **commande inchangée**, donc toujours payable |
| `PENDING` | `PENDING` | ignoré, aucune écriture |
| `SUCCESS` | quoi que ce soit | `DUPLICATE`, aucune écriture |
| `FAILED` | quoi que ce soit | `DUPLICATE`, aucune écriture |
| `CANCELLED` | quoi que ce soit | `DUPLICATE`, aucune écriture |
| n'importe lequel | montant ou devise divergents | `MISMATCH` — incident `CRITICAL`, **aucune** transition |

Il n'y a **pas** de résurrection : un encaissement terminal ne redevient jamais
`PENDING`. Une reprise crée une **nouvelle ligne**, jamais une réécriture.

⚠️ Conséquence à connaître : un paiement `CANCELLED` à la main sur lequel le
prestataire annonce ensuite `COMPLETED` reste `CANCELLED`, et la commande n'est
jamais confirmée — client débité, commande absente. C'est précisément pourquoi
`reject` est interdit sur les paiements non-`MANUAL` (voir plus bas).

**Invariant : un échec de paiement n'annule jamais une commande.** C'est ce qui
rend la reprise possible. Seuls le cron d'expiration et une décision humaine
annulent.

### Retrouver un encaissement — `GET /payments/by-order/:orderId`

Rend la **dernière** tentative d'une commande, ou `null`. Lecture pure : elle ne
crée rien, n'interroge pas le prestataire et ne fait avancer aucun statut.

Elle existe pour le web, où recharger la page est un geste ordinaire. Sans elle,
retrouver un paiement en cours imposerait de rejouer `POST /payments` — une
écriture, qui peut relancer une demande chez l'opérateur, pour une simple
lecture. Le rafraîchissement d'un `PENDING` reste le travail de
`GET /payments/:id/status`.

⚠️ Déclarée **avant** `:paymentId/status` dans le contrôleur, sinon `by-order`
serait capturé comme un identifiant de paiement.

### Compatibilité client — `X-Lilia-Payment-Flow`

`POST /payments` refuse en **426 `CLIENT_UPGRADE_REQUIRED`** tout client qui
n'annonce pas `X-Lilia-Payment-Flow: provider`, **sauf en mode `MANUAL`**.

**Pourquoi.** Les deux flux ne demandent pas la même chose au client. En mode
manuel il compose un virement vers un numéro que le serveur lui donne ; avec un
prestataire il n'a rien à composer — une demande arrive sur son téléphone et il
saisit son code. Un client écrit pour le premier et branché sur le second
affiche sa consigne avec `instructions.phone` **vide** : ses libellés sont
compilés dans le binaire, aucune réponse serveur ne peut les rendre justes.

C'est arrivé en production le 31/08/2026 : le backend est passé en `PAWAPAY`
alors que l'application publiée et le site attendaient encore un virement. On ne
peut pas rattraper ces clients, seulement **ne pas les engager** — sans la
garde, l'appel déclenche une vraie demande USSD dont l'application ne parle
jamais au client, puis lui montre un numéro vide.

**Une capacité, pas une version** : `provider` dit ce que le client sait faire.
Un numéro de version imposerait une table de correspondance à tenir pour trois
applications, et qui se périmerait.

⚠️ **Ce n'est pas un contrôle de sécurité** — l'en-tête est déclaratif et
falsifiable. Un client qui ment ne casse que son propre écran.

⚠️ **La garde ne se déclenche jamais en mode `MANUAL`.** C'est ce qui rend la
bascule sûre dans les deux sens : repasser en `MANUAL` débloque instantanément
tous les clients installés, sans rien publier.

| Client | En-tête | `MANUAL` | `PAWAPAY` |
|---|---|---|---|
| App publiée (pré-pawaPay) | absent | ✅ | **426** |
| App à jour | `provider` | ✅ | ✅ |
| Site à jour | `provider` | ✅ | ✅ |

Sur un client ancien, le 426 tombe dans sa boîte de dialogue de reprise :
« votre commande a bien été créée … ne faites aucun virement pour l'instant ».
La commande reste intacte et le cron d'expiration la libère.

### Les gestes manuels sont réservés aux paiements `MANUAL`

`POST /payments/:id/confirm` et `.../reject` refusent en **409
`PAYMENT_NOT_MANUAL`** tout encaissement dont le `provider` stocké n'est pas
`MANUAL`.

Confirmer un dépôt pawaPay encore en vol déclarerait payée une commande pour
laquelle rien n'a été débité — et le `FAILED` qui arriverait ensuite ne pourrait
plus rien défaire, puisque le premier statut terminal gagne par construction.
Symétriquement, le rejeter le figerait en `CANCELLED` : le `COMPLETED` suivant
serait compté comme doublon, et un client débité n'aurait jamais sa commande.

Le discriminant est le **provider de la ligne**, jamais le mode courant : un
virement ouvert en mode `MANUAL` reste confirmable à la main après une bascule
vers `PAWAPAY`, sinon la bascule laisserait sans issue les virements réels déjà
reçus. Sur un encaissement confié à un prestataire, le geste disponible est
`POST /payments/:id/reconcile` — on ne décide pas, on demande à l'opérateur.

---

## 4. Reversement (payout) — **jamais automatique**

```
Order PRET          →  rend la commande ÉLIGIBLE. Rien de plus.
                       Aucun événement ne déclenche de virement.
        │
        ▼
ADMIN clique « Payer le restaurant »
        │
POST /admin/orders/:orderId/payout
        │
        ├─ checkEligibility()      9 contrôles serveur (§ ci-dessous)
        ├─ computePayoutBreakdown() recalculé, jamais repris du client
        ├─ RestaurantPayout créé PENDING + payoutId (UUIDv4)
        │     ↳ @@unique([orderId]) : deux admins simultanés ⇒ un seul
        ▼
POST /v2/payouts (pawaPay)
        ▼
   callback → SUCCESS   ⇒ 💰 vendeur notifié, `paid = true`
             → FAILED    ⇒ ⚠️ incident, retry possible
```

### Les 9 contrôles d'éligibilité

Tous **côté serveur**, rejoués au moment du clic. Le front peut afficher ce
qu'il veut.

| Contrôle | Code d'erreur |
|---|---|
| La commande existe | `ORDER_NOT_FOUND` |
| Elle n'est pas annulée | `ORDER_CANCELLED` |
| Elle est `PRET`, `EN_ROUTE` ou `LIVRER` | `ORDER_NOT_READY` |
| Le client a payé (`Payment SUCCESS`) | `PAYMENT_NOT_COMPLETED` |
| Aucun remboursement ouvert | `ORDER_REFUNDED` |
| Le vendeur a un numéro **et** un opérateur de reversement | `VENDOR_PAYOUT_ACCOUNT_MISSING` |
| Il n'a pas déjà été payé | `PAYOUT_ALREADY_COMPLETED` |
| Aucun reversement en cours | `PAYOUT_IN_PROGRESS` |
| Le mode courant sait reverser | `PROVIDER_DOES_NOT_SUPPORT_PAYOUT` |

`EN_ROUTE` et `LIVRER` restent éligibles : un reversement oublié à `PRET` ne doit
pas devenir impossible.

### Concurrence — deux administrateurs, un seul virement

Ce n'est **pas** `checkEligibility` qui protège : deux appels simultanés la
passent tous les deux. C'est la contrainte `@@unique([orderId])` sur
`restaurant_payouts`. La seconde insertion reçoit un `P2002`, traduit en 409.
La base arbitre, et elle ne peut pas se tromper.

### Retry

Une nouvelle tentative **supprime** la ligne `FAILED` et repart avec un **nouvel**
identifiant. Réutiliser un `payoutId` déjà consommé ferait répondre
`DUPLICATE_IGNORED` : la tentative semblerait acceptée sans que rien ne parte.
L'historique de l'échec survit dans `PaymentEvent`, qui n'est jamais purgé.

Le retry est **refusé** tant que le reversement est `PENDING` ou `SUCCESS` :
réessayer un virement peut-être déjà parti est le seul moyen de payer deux fois
un vendeur, et cet argent-là ne revient pas.

### Compte de reversement du vendeur

`Restaurant.payoutPhoneNumber` + `payoutProvider`, **distincts** de
`Restaurant.phone` (contact) et du téléphone du propriétaire. Rien ne dit que le
numéro sur lequel on appelle le restaurant est celui sur lequel il veut être payé.

Modifiables **uniquement** par `PATCH /admin/vendors/:id/payout-account`
(ADMIN). Volontairement absents d'`UpdateRestaurantDto`, ouvert au
RESTAURATEUR : un compte compromis détournerait sinon tous les reversements
suivants sans qu'aucune alerte ne parte.

---

## 5. Webhooks

Deux routes **distinctes**, jamais une seule qui devinerait le type :

| Route | Alimente |
|---|---|
| `POST /webhooks/pawapay/deposits` | `Payment` |
| `POST /webhooks/pawapay/payouts` | `RestaurantPayout` |

### Authentification — fail-closed

1. **Signature RFC-9421** dès que `PAWAPAY_PUBLIC_KEY` est configurée :
   `Content-Digest` vérifié sur le **corps brut** (d'où `rawBody: true` dans
   `main.ts`), puis signature contre la clé publique, plus une fenêtre de
   fraîcheur de 5 min contre le rejeu.
2. **Liste blanche d'IP** (`PAWAPAY_CALLBACK_IPS`) en repli — les callbacks
   signés sont optionnels chez pawaPay.
3. **Ni l'une ni l'autre configurée ⇒ tout est refusé.** Un endpoint public qui
   mute des lignes d'argent ne s'ouvre pas « en attendant ».

### Obtenir la clé publique pawaPay

Les callbacks signés sont **optionnels** chez pawaPay et **désactivés par
défaut**. Il faut donc les activer, puis récupérer la clé qui sert à les
vérifier.

1. Se connecter au **tableau de bord pawaPay**, sur l'environnement voulu —
   `dashboard.sandbox.pawapay.io` ou `dashboard.pawapay.io`. Les clés sont
   **propres à chaque environnement** : celle du sandbox ne vérifie pas un
   callback de production.
2. Ouvrir la section des **callbacks / webhooks**, y déclarer les deux URL
   (`/webhooks/pawapay/deposits` et `/webhooks/pawapay/payouts`) et **activer la
   signature** des callbacks.
3. pawaPay publie alors sa **clé publique** (PEM, `-----BEGIN PUBLIC KEY-----`).
   C'est **leur** clé, pas une paire à générer : elle sert uniquement à vérifier
   ce qu'ils envoient. Rien de secret — mais une clé erronée fait refuser tous
   les callbacks.
4. La poser telle quelle dans `PAWAPAY_PUBLIC_KEY` sur Render. Les sauts de
   ligne échappés (`\n`) sont gérés.

> Si la section n'apparaît pas, la fonctionnalité n'est pas activée sur le
> compte : la demander au support pawaPay. En attendant, `PAWAPAY_CALLBACK_IPS`
> est le seul repli — lire l'avertissement ci-dessous avant de l'utiliser.

### ⚠️ Liste blanche d'IP : à ne prendre qu'en dernier recours

L'application est servie par Render, **derrière Cloudflare**. Une requête arrive
donc avec `X-Forwarded-For: <client>, <edge Cloudflare>`, et
`TRUST_PROXY_HOPS=1` fait s'arrêter Express sur l'edge : `req.ip` vaut une
adresse **Cloudflare**, jamais celle de pawaPay. Comparée à la liste blanche,
elle ne correspond à rien — le repli est inopérant sans que rien ne le signale.

**La correction évidente est un piège.** Passer `TRUST_PROXY_HOPS` à 2 ferait
retomber `req.ip` sur une entrée de `X-Forwarded-For`, c'est-à-dire sur une
valeur que l'appelant contrôle. N'importe qui pourrait alors envoyer
`X-Forwarded-For: 3.64.89.224`, se faire passer pour pawaPay et **fabriquer des
confirmations de paiement**. Le nombre de sauts reste à **1**.

L'adresse est donc résolue par `common/http/client-ip.ts`, qui lit
`CF-Connecting-IP` — que Cloudflare écrase à chaque requête, et que l'appelant
ne peut donc pas choisir. Cette garantie tombe si l'application devient
joignable sans passer par l'edge : **la signature reste le seul dispositif
insensible à la topologie réseau.**

Adresses pawaPay, pour mémoire : sandbox `3.64.89.224` ; production
`18.192.208.15`, `18.195.113.136`, `3.72.212.107`, `54.73.125.42`,
`54.155.38.214`, `54.73.130.113`. Une liste qui se périme coupe les paiements en
silence — raison de plus de préférer la signature.

### Un callback refusé n'est plus silencieux

Tout rejet (`401`) déclenche désormais une alerte Sentry
`pawapay.callback_rejected`, avec son motif : `not-configured`,
`ip-not-allowlisted` ou `signature:<détail>`.

Sans elle, un webhook fail-closed mal configuré ne se voit pas : il répond 401,
pawaPay rejoue quinze minutes puis abandonne, et plus aucun encaissement n'est
confirmé par sa voie normale — seulement par l'interrogation de l'application
cliente, avec le cron comme dernier filet. C'est précisément ce qui s'est
produit le 01/09/2026.

### Convention de réponse

pawaPay rejoue pendant **15 minutes** tant qu'il n'obtient pas `200`.

| Réponse | Quand |
|---|---|
| `200 processed` | appliqué |
| `200 duplicate` | rejeu — le premier statut terminal a gagné |
| `200 ignored` | transaction inconnue ou payload inexploitable : rejouer n'aiderait pas |
| `200 mismatch` | écart de montant — incident ouvert, arbitrage humain |
| `401` | signature absente ou invalide |
| `503` | erreur **transitoire** — pawaPay doit rejouer |

⚠️ Répondre `200` sur une panne de base ferait considérer le callback comme
livré, et le paiement ne serait **jamais** confirmé : un client aurait payé, sa
commande expirerait quand même. C'est le défaut corrigé sur le webhook MTN (fix
M15) — il ne doit pas revenir.

### Callbacks hors ordre

Le premier statut terminal gagne. Un `FAILED` arrivant après un `COMPLETED` ne
peut pas défaire un encaissement — mais il reste dans `PaymentEvent` pour
l'enquête.

### Ce qui a été vérifié sur un serveur réel

Le 31/08/2026, contre une instance lancée en `PAYMENT_MODE=PAWAPAY` et une base
PostgreSQL vierge migrée. Ces résultats sont reproductibles avec la procédure
du §10 ; ils ne remplacent **pas** un vrai paiement (§12).

| Envoi | Réponse | Effet en base |
|---|---|---|
| `COMPLETED` sur un `PENDING` | `200 processed` | `SUCCESS`, commande `PAYER`, `paidAt` posé, **1** outbox `order.paid` |
| le même, rejoué | `200 duplicate` | aucun |
| `FAILED` **après** le `COMPLETED` | `200 duplicate` | aucun — l'encaissement tient, pas de `failureCode` écrit |
| `depositId` inconnu | `200 ignored` | trace `IGNORED` dans `PaymentEvent`, `paymentId` nul |
| corps sans `depositId` | `200 ignored` | aucun |
| dépôt posté sur `/payouts` | `200 ignored` | aucun — pas de contamination entre les deux flux |
| `COMPLETED` avec 100 F au lieu de 6 400 | `200 mismatch` | **aucune transition**, incident `CRITICAL` ouvert |
| `COMPLETED` en `USD` | `200 mismatch` | idem |
| toutes routes d'argent, sans jeton | `401` | — |

`PaymentEvent` contenait bien une ligne par signal, avec son `outcome`
(`APPLIED` / `DUPLICATE` / `IGNORED` / `MISMATCH`), et l'outbox exactement un
`order.paid` — le vendeur n'est prévenu ni deux fois, ni pour la commande dont
le montant divergeait.

---

## 6. Réconciliation

`PaymentReconciliationService`, toutes les **2 minutes**, verrou Redis.

| | Encaissements | Reversements |
|---|---|---|
| Délai de grâce | 3 min | 3 min |
| Interroge | `GET /v2/deposits/{id}` | `GET /v2/payouts/{id}` |
| Applique par | `applyCollectionProviderStatus` | `applyPayoutProviderStatus` |
| Si le prestataire ne connaît pas la transaction après 15 min | **clôturé** `FAILED` + `RECONCILIATION_TIMEOUT` | **alerte seulement** |

**Asymétrie délibérée.** Un encaissement abandonné à tort ne coûte qu'une
nouvelle demande au client. Un reversement marqué en échec à tort invite un
administrateur à réessayer — et si la demande était en fait partie, le vendeur
est payé deux fois, sans récupération possible. On alerte, un humain tranche.

---

## 7. Remboursements et annulations

| Situation | Conséquence |
|---|---|
| Payé, **pas encore reversé** | Cas simple : `Refund` ouvert, l'argent n'a pas quitté Lilia Food. Le reversement devient inéligible (`ORDER_REFUNDED`). |
| Payé **et** reversé | L'argent est chez le vendeur. `RestaurantPayout.status = SUCCESS` reste vrai — on ne prétend pas pouvoir le reprendre. Le règlement se fait hors système (compensation sur un reversement suivant, ou accord commercial). |
| Encaissé sur une commande expirée | Aucune transition forcée. `payment.orphaned` → incident `CRITICAL` + `Refund`. L'argent existe, la commande non : c'est un litige, pas un cas nominal. |

> pawaPay expose une API de remboursement (`POST /v2/refunds`). Elle n'est
> **pas** branchée : le flux `Refund` reste manuel, ce qui convient au volume de
> lancement et évite d'automatiser un mouvement d'argent sortant avant d'avoir
> observé les cas réels.

---

## 8. Notifications

| Moment | Client | Vendeur |
|---|---|---|
| Commande créée | 🧾 « enregistrée, finalisez le paiement » | **rien** |
| Paiement réussi | ✅ « Commande confirmée » | 🔔 « Nouvelle commande payée » *(outbox, garanti + escalade SMS à 10 min)* |
| Paiement échoué | ❌ « non abouti » + reprise | rien |
| **Reversement réussi** | rien | 💰 « Votre paiement de X F pour #ABC a été effectué » |
| **Reversement échoué** | rien | ⚠️ « en attente, Lilia Food relance » *(sans le code technique)* + incident |

Le vendeur n'était prévenu qu'à `order.created`, donc **avant tout paiement**.
Avec un encaissement manuel (des heures d'écart) il triait lui-même ; avec un
prestataire qui tranche en une minute, chaque paiement abandonné lui aurait valu
un push pour une commande qui n'existera jamais.

Le client, lui, ne voit **jamais** la commission, le reversement ni les frais du
prestataire.

---

## 9. Configuration

```env
PAYMENT_MODE=PAWAPAY                    # MANUAL | SANDBOX | MTN_PRODUCTION | PAWAPAY

PAWAPAY_API_URL=https://api.sandbox.pawapay.io   # prod : https://api.pawapay.io
PAWAPAY_API_TOKEN=                      # requis si PAYMENT_MODE=PAWAPAY
PAWAPAY_PUBLIC_KEY=                     # signature des callbacks (recommandé)
PAWAPAY_CALLBACK_IPS=                   # repli si pas de signature — l'UN des DEUX est obligatoire

PAWAPAY_MTN_PROVIDER=MTN_MOMO_COG       # 🔴 à confirmer via GET /v2/active-conf
PAWAPAY_AIRTEL_PROVIDER=AIRTEL_COG      # 🔴 idem
PAWAPAY_STATEMENT_PREFIX=LiliaFood      # ≤ 12 car. (limite pawaPay : 22 avec la référence)

PAYMENT_MAX_ATTEMPTS=3
PAYMENT_RECONCILIATION_TIMEOUT_MINUTES=15

# ⚠️ En PAYMENT_MODE=PAWAPAY, l'UNE des deux lignes ci-dessus
# (PAWAPAY_PUBLIC_KEY / PAWAPAY_CALLBACK_IPS) est OBLIGATOIRE : le boot échoue
# sinon. Le webhook est fail-closed — sans l'une d'elles il répondrait 401 à
# tous les callbacks, et seul le cron de réconciliation confirmerait les
# paiements, avec deux minutes de retard. Même raisonnement que
# MTN_MOMO_WEBHOOK_SECRET et REDIS_URL : mieux vaut ne pas démarrer que
# démarrer à moitié.

# À ramener avec un encaissement instantané (étaient 45 / 360)
ORDER_PAYMENT_TIMEOUT_MINUTES=15
ORDER_PENDING_PAYMENT_TIMEOUT_MINUTES=30
```

### URL de callback à déclarer dans le tableau de bord pawaPay

```
Deposits : https://lilia-backend.onrender.com/webhooks/pawapay/deposits
Payouts  : https://lilia-backend.onrender.com/webhooks/pawapay/payouts
```

---

## 10. Procédure sandbox

1. **Configurer le compte** : `PAYMENT_MODE=PAWAPAY`,
   `PAWAPAY_API_URL=https://api.sandbox.pawapay.io`, jeton sandbox.
2. **Confirmer les codes opérateur** — *à faire en premier* :
   ```bash
   curl -H "Authorization: Bearer $PAWAPAY_API_TOKEN" \
        https://api.sandbox.pawapay.io/v2/active-conf | jq '.countries[] | select(.country=="COG")'
   ```
   Vérifier : le pays `COG` est présent, la devise `XAF` est listée,
   `DEPOSIT` **et** `PAYOUT` sont `OPERATIONAL`, et relever les `provider` exacts.
   Ajuster `PAWAPAY_MTN_PROVIDER` / `PAWAPAY_AIRTEL_PROVIDER`.
3. **Vérifier le format du MSISDN** avec un dépôt sur un numéro connu. Se
   tromper de forme ne produit **aucune erreur visible** : la demande part vers
   un numéro qui n'existe pas. Voir la note dans `pawapay.mapper.ts#toMsisdn`.
4. **Dérouler les scénarios** :
   | Scénario | Attendu |
   |---|---|
   | Dépôt MTN validé | `Order PAYER`, push client + push vendeur |
   | Dépôt Airtel validé | idem |
   | Dépôt refusé | `Payment FAILED`, commande **toujours** `EN_ATTENTE` |
   | Callback rejoué | `200 duplicate`, aucune seconde notification |
   | Callback perdu (couper le webhook) | résolu par le cron sous 2 min |
   | Reversement validé | `RestaurantPayout SUCCESS`, push vendeur |
   | Reversement refusé | `FAILED` + incident, retry possible |
   | Double clic administrateur | un seul reversement, 409 sur le second |
5. **Vérifier le journal** : `GET /payments/:id/events` et
   `GET /admin/payouts/:id/events` doivent contenir une ligne par signal reçu.

## 10 bis. Le premier paiement réel — procédure pas à pas

Écrite pour être suivie par le propriétaire de Lilia Food, sans lecture de code.
**Rien de technique ne bloque ce test ; seule la configuration du compte
pawaPay reste à faire.**

### Étape 1 — Vérifier le compte pawaPay (à faire en premier)

```bash
curl -H "Authorization: Bearer $PAWAPAY_API_TOKEN" \
     https://api.pawapay.io/v2/active-conf | jq '.countries[] | select(.country=="COG")'
```

Quatre choses à lire dans la réponse, **avant tout le reste** :

1. le pays `COG` est présent ;
2. la devise `XAF` est listée ;
3. `DEPOSIT` **et** `PAYOUT` sont `OPERATIONAL` — le second est souvent une
   autorisation commerciale **distincte**, à demander explicitement ;
4. les codes `provider` exacts. `MTN_MOMO_COG` et `AIRTEL_COG` ne sont que des
   **valeurs par défaut** : s'ils diffèrent, poser `PAWAPAY_MTN_PROVIDER` et
   `PAWAPAY_AIRTEL_PROVIDER`.

### Étape 2 — Renseigner les variables sur Render

```env
PAYMENT_MODE=PAWAPAY
PAWAPAY_API_URL=https://api.pawapay.io
PAWAPAY_API_TOKEN=<jeton de production>
PAWAPAY_PUBLIC_KEY=<clé publique pawaPay>     # ou PAWAPAY_CALLBACK_IPS
ORDER_PAYMENT_TIMEOUT_MINUTES=15
ORDER_PENDING_PAYMENT_TIMEOUT_MINUTES=30
```

Si ni la clé ni la liste d'IP n'est renseignée, **le service refusera de
démarrer** avec un message explicite. C'est voulu.

### Étape 3 — Déclarer les deux URL de callback chez pawaPay

```
Deposits : https://lilia-backend.onrender.com/webhooks/pawapay/deposits
Payouts  : https://lilia-backend.onrender.com/webhooks/pawapay/payouts
```

### Étape 4 — Passer la commande de test

| | |
|---|---|
| **Montant** | le plus petit panier possible, **500 à 1 000 F** de produits. Le total réel sera un peu supérieur (livraison + 8 % de frais de service) — c'est normal, et c'est ce total que l'opérateur débitera. |
| **Numéro** | un téléphone MTN MoMo **réellement approvisionné**, dont vous avez le code secret sous la main. |
| **Où** | `https://liliafood.com` → un vendeur ouvert → panier → « Commander » → choisir MTN Mobile Money → renseigner le numéro. |
| **Vendeur** | de préférence un compte de test, pour ne pas déranger un vrai commerçant. |

### Étape 5 — Ce qui doit se passer, dans l'ordre

1. la page bascule sur le détail de la commande, bloc **« Paiement en attente »**
   avec un chronomètre ;
2. **une demande arrive sur le téléphone** — c'est le point qui valide le format
   MSISDN ;
3. vous saisissez votre code secret ;
4. sous quelques secondes, le bloc passe à **« Paiement confirmé »** avec le
   montant, le moyen de paiement, la date et une référence ;
5. la commande affiche **« Paiement confirmé »** dans son suivi ;
6. le vendeur reçoit **une** notification « nouvelle commande payée ».

> Si rien n'arrive sur le téléphone après 20 secondes, l'écran propose de
> composer `*105#` (MTN) ou `*555#` (Airtel) et de valider le paiement en
> attente. Si vous ne trouvez rien à valider dans ce menu, **c'est le format du
> numéro qui est en cause** — le point 2 du §12.

### Étape 6 — Où vérifier, dans l'ordre

| Quoi | Où | Ce qu'on doit voir |
|---|---|---|
| Le paiement | Admin → **Paiements** | une ligne `Confirmé`, provider `pawaPay`, une référence, le montant, éventuellement les frais |
| La commande | Admin → **Commandes** | statut `Payé`, et en dépliant la commande le bloc « Argent » avec `Commande payée` |
| Le signal reçu | `GET /payments/:id/events` (ADMIN) | au moins une ligne `WEBHOOK` / `COMPLETED` / `APPLIED` |
| Côté pawaPay | tableau de bord pawaPay | le dépôt, au même montant et au même statut |
| Le vendeur | application vendeur | la commande est arrivée, et **une seule fois** |

### Étape 7 — Le reversement, séparément

Il n'est **jamais** automatique. Une fois la commande passée à `PRET` :

1. Admin → **Commandes** → déplier la commande → bloc « Argent » ;
2. vérifier le net à reverser et le numéro masqué du vendeur ;
3. **« Payer le restaurant »** → confirmer dans la modale.

Prérequis souvent oublié : le vendeur doit avoir un compte de reversement
(`PATCH /admin/vendors/:id/payout-account`) **et** le wallet pawaPay doit être
approvisionné — un reversement puise dans ce solde, il ne transfère pas l'argent
du client.

### En cas de problème

| Symptôme | Cause la plus probable | Geste |
|---|---|---|
| Rien n'arrive sur le téléphone | format MSISDN | vérifier le numéro tel qu'envoyé, cf. `pawapay.mapper.ts#toMsisdn` |
| Le paiement reste « en attente » plus de 2 min | callback perdu | il se résout seul (cron, 2 min). Sinon Admin → Paiements → **Réconcilier** |
| Le paiement reste bloqué et pawaPay le dit `COMPLETED` | callback refusé | vérifier `PAWAPAY_PUBLIC_KEY` / liste d'IP, puis **Réconcilier** |
| `mismatch` dans les journaux | montant divergent | **ne rien forcer** — un incident `CRITICAL` est ouvert, arbitrage humain |
| « Payer le restaurant » grisé | commande pas `PRET`, non payée, ou vendeur sans compte | le motif exact est affiché sous le bouton |
| `PAWAPAY_WALLET_OUT_OF_FUNDS` | wallet à sec | l'approvisionner, puis **Réessayer le reversement** |

> ⚠️ **Ne jamais utiliser « Confirmer » sur un paiement pawaPay** — le bouton
> n'existe d'ailleurs plus que pour les virements manuels, et le serveur refuse
> le geste en 409. Confirmer à la main un dépôt en vol déclarerait payée une
> commande pour laquelle rien n'a été débité.

---

## 11. Procédure production

1. **Prérequis pawaPay** — voir §12.
2. Basculer `PAWAPAY_API_URL=https://api.pawapay.io` + jeton de production.
3. Déclarer les deux URL de callback de production.
4. **Renseigner les comptes de reversement** de tous les vendeurs actifs
   (`PATCH /admin/vendors/:id/payout-account`). Sans cela, le reversement est
   refusé — proprement, mais refusé.
5. **Bascule progressive** : commencer par quelques comptes réels. Un
   prestataire se valide avec de l'argent réel — le sandbox ne reproduit ni les
   délais opérateur, ni les refus.
6. **Surveiller** : `payment.mismatch`, `payment.orphan`,
   `payout.unknown_status` et le taux d'échec sur 15 min.
7. **Plan de repli** : `PAYMENT_MODE=MANUAL` + redémarrage. Le mode manuel est
   resté intact et opérationnel.

> ⚠️ **Render** : sur un plan qui met le service en veille, un callback arrivant
> sur une instance endormie subit un démarrage à froid de 30 à 60 s et peut être
> considéré en échec. Le cron de réconciliation couvre le cas, mais le plan
> payant est fortement recommandé.

---

## 12. Dépendances pawaPay non techniques

Ces points ne se règlent pas dans le code :

| Dépendance | Pourquoi |
|---|---|
| **Compte marchand Congo (COG) ouvert et KYC validé** | Sans lui, aucun appel n'aboutit. Bloquant pour la production, pas pour le développement. |
| **Capacité `DEPOSIT` activée** pour XAF / COG | Encaisser. |
| **Capacité `PAYOUT` activée** pour XAF / COG | ⚠️ Souvent une **autorisation commerciale distincte** de l'encaissement : reverser des tiers relève d'un agrément différent. À demander explicitement. |
| **Wallet approvisionné** | Un reversement puise dans le solde du wallet pawaPay, il ne « transfère » pas l'argent du client. Wallet à sec ⇒ `PAWAPAY_WALLET_OUT_OF_FUNDS`. **Il faut donc alimenter le wallet à partir des encaissements**, selon le cycle de règlement de pawaPay. |
| **Clés de signature** | Générer une paire, déposer la publique côté pawaPay, activer les callbacks signés. |
| **Plages d'IP des callbacks** | Seulement si on active la liste blanche — une liste obsolète coupe les paiements en silence. |

---

## 13. Journal et observabilité

Table `PaymentEvent`, **append-only**, une ligne par signal reçu
(callback, réconciliation, interrogation client, initiation).

Trois usages qu'aucune autre table ne rend :
- la **preuve** de ce que le prestataire a envoyé et quand (`metadata` est
  écrasé à chaque écriture) ;
- la détection des callbacks **hors ordre** ;
- le **rejeu** d'un callback perdu sans le redemander.

`outcome` vaut `APPLIED`, `DUPLICATE`, `IGNORED` ou `MISMATCH` — de quoi mesurer
le taux de rejeu et repérer une incohérence en supervision.

**Jamais journalisé** : code secret (on ne le voit jamais — c'est l'intérêt du
dispositif), jeton d'API, en-têtes `Authorization`, corps de réponse brut du
prestataire. **Masqués** : numéros (`maskPhone`), références (`maskRef`).

⚠️ **La `redact` de pino ne suffit pas.** Elle agit sur les propriétés d'un
objet journalisé, pas sur une valeur interpolée dans le message. Le rail MTN
écrivait `JSON.stringify(config.headers)` : la subscription key et le
`Authorization` partaient en clair dans `msg`, hors de portée de la redaction.
Corrigé par `redactHeaders()` (`mtn-momo-token.service.ts`), verrouillé par un
test. **Règle : ne jamais interpoler d'en-têtes ni de configuration dans un
message de log — passer un objet, ou masquer explicitement.**

### Retrouver un paiement — ce qui est disponible

| Question | Où |
|---|---|
| Que s'est-il passé sur ce paiement ? | `GET /payments/:id/events` (ADMIN) — une ligne par signal |
| Le prestataire a-t-il répondu ? | même route : `source` = `WEBHOOK` / `RECONCILIATION` / `CLIENT_POLL` |
| Ce callback a-t-il été appliqué ? | `outcome` = `APPLIED` / `DUPLICATE` / `IGNORED` / `MISMATCH` |
| Quel montant, quelle référence ? | `GET /admin/orders/:id/financials` |
| Le vendeur a-t-il été payé ? | idem, `restaurant.paid` — **seul `SUCCESS` compte** |

⚠️ **Angle mort connu.** `PaymentEvent.payoutId` est en `onDelete: SetNull`, et
`retryPayout` **supprime** la ligne échouée : après une reprise, les événements
de la tentative précédente ne remontent plus dans
`GET /admin/payouts/:id/events`. Ils survivent en base et restent retrouvables
par `(provider, externalId)` — mais pas depuis l'administration. À garder en
tête lors d'une enquête sur un reversement repris.

**Alertes Sentry** : `payment.mismatch`, `payment.orphan`,
`payout.mismatch`, `payout.unknown_status`, `payment.reconciliation_timeout`.

---

## 14. Traçabilité administrative

Toute opération qui envoie de l'argent laisse une ligne dans `AdminAuditLog` :

| Action | Métadonnées |
|---|---|
| `PAYOUT_REQUESTED` | montants, taux, statut, vendeur, note |
| `PAYOUT_RETRIED` | idem |
| `VENDOR_PAYOUT_ACCOUNT_UPDATED` | numéros **masqués** avant/après, opérateur |
| `PAYMENT_CONFIRMED` / `PAYMENT_REJECTED` | mode manuel |

Le numéro complet ne va pas dans le journal : masqué suffit à reconstituer un
changement, et le journal est consultable.
