# SMS de bienvenue (Infobip) & email de bienvenue (Mailtrap) — hors FCM

- **Date** : 2026-06-12
- **Statut** : Design validé, en attente de relecture finale
- **Périmètre repos** : `lilia-backend` (cœur) + `lilia-app` (écran de collecte du numéro)
- **Canaux concernés** : SMS (Infobip), Email (Mailtrap). **Hors FCM** (les push commande existants restent inchangés).

---

## 1. Objectif

Garder le client « à l'affût » en dehors des notifications push FCM, via deux messages
transactionnels de **bienvenue** envoyés une seule fois à la première inscription :

1. **Email de bienvenue** (Mailtrap) — pour tout nouvel inscrit ayant un email.
2. **SMS de bienvenue** (Infobip) — pour tout nouvel inscrit ayant un numéro de téléphone,
   que le numéro soit saisi à l'inscription (email/password) ou complété après coup
   (connexion Google).

## 2. Périmètre

**Dans le périmètre :**
- Email de bienvenue via Mailtrap, recâblé et idempotent.
- SMS de bienvenue via Infobip, idempotent, couvrant les deux flux d'inscription.
- Récupération du numéro côté Google : écran **skippable** dans `lilia-app`.
- Réparation/réécriture du `SmsService` (cassé) sur le fournisseur **Infobip**.

**Hors périmètre (décisions explicites) :**
- ❌ **SMS au restaurant à chaque commande** — abandonné : coût récurrent proportionnel au
  volume de commandes. Le restaurant continue d'être notifié par **FCM** (inchangé).
- ❌ **SMS au client quand le livreur est `EN_ROUTE`** — abandonné pour la même raison. Le
  client continue d'être notifié par **FCM** (inchangé). `OrdersListener` **n'est pas modifié**.
- ❌ **Email « nouveau menu »** — code mort actuellement inactif (voir §4), supprimé. S'il est
  souhaité un jour, ce sera une feature distincte.

## 3. Objectif de coût

En se limitant au SMS de bienvenue (1 SMS par nouvel inscrit ayant un numéro), le coût ne
dépend plus du volume de commandes. Estimation (tarif +242 à confirmer dans le portail Infobip,
fourchette de référence 15–35 XAF/segment, message à **1 segment**) :

| Scénario | Inscrits/mois avec n° | SMS/mois | @ 15 XAF | @ 35 XAF |
|---|---|---|---|---|
| Démarrage | ~120 | ~120 | ~1 800 XAF (~3 $) | ~4 200 XAF (~7 $) |
| Croissance | ~400 | ~400 | ~6 000 XAF (~10 $) | ~14 000 XAF (~23 $) |
| Maturité | ~1 200 | ~1 200 | ~18 000 XAF (~30 $) | ~42 000 XAF (~70 $) |

Formule : `coût mensuel ≈ inscrits_avec_numéro × prix_segment × segments_par_SMS`.
Le message de bienvenue doit rester **sans accents et < 160 caractères** pour tenir en
**1 segment GSM-7** (un accent force l'encodage UCS-2 = 70 caractères/segment, doublant le coût).

## 4. État actuel constaté (avant travaux)

- `EmailService` (Mailtrap) **fonctionne** : `sendWelcomeEmail(email, nom)` opérationnel,
  package `mailtrap` installé, init via `MAILTRAP_API_TOKEN`. `EmailModule` exporte bien
  `EmailService`.
- **L'email de bienvenue ne part pas** : sa logique vit dans `listeners/email.listener.ts`
  (`@OnEvent('user.created')`), mais ce listener **n'est pas enregistré** dans `app.module.ts`.
  Un commentaire ligne 59 (« EmailListener supprimé — logique déplacée dans UserListener »)
  ne correspond pas à la réalité : `UserListener` est **vide**.
- `email.listener.ts` contient aussi `handleMenuCreatedForEmail` (email « nouveau menu »).
  `MenusListener.handleMenuCreated` n'envoie **que** du FCM, pas d'email. Donc l'email
  « nouveau menu » **ne part jamais** aujourd'hui → code mort.
- `SmsService` (`modules/sms/sms.service.ts`) est **cassé** : l'initialisation du client est
  avalée par un commentaire (`this.client = at.SMS;` jamais exécuté, `at` jamais importé), et
  **aucun listener ne l'appelle**. `SmsModule` **n'exporte pas** `SmsService`.
- Bâti pour Africa's Talking, qui **ne couvre pas le Congo-Brazzaville (+242)** → bascule
  vers **Infobip** (couverture 190+ pays, SDK Node officiel).
- Modèle `User` : possède `phone String?`, `email`, `nom`, `createdAt`. **Pas** de flag de
  bienvenue.
- `UpdateUserDto` possède déjà `phone` → `PUT /users/me` peut enregistrer un numéro.
- Émission de `user.created` : `UserService.syncFromFirebase` (users.service.ts), uniquement
  si `isNewUser`. Le numéro provient du paramètre `phone` (body `/users/sync`), pas du token.
- Flux Flutter : signup email/password collecte déjà le numéro ; `signInWithGoogle()` envoie
  `'telephone': user.phoneNumber`, **quasi toujours `null`** pour Google OAuth → trou à combler.

## 5. Décisions de conception

1. **Idempotence par flags DB** (option retenue parmi flag / numéro obligatoire / fenêtre
   temporelle). Deux flags séparés sur `User` car email et SMS peuvent partir à des moments
   différents (cas Google).
2. **Fournisseur SMS : Infobip** (remplace Africa's Talking). `SmsService` est l'unique point
   de couture ; les listeners ignorent le fournisseur.
3. **Email : Mailtrap** (inchangé), simplement recâblé et rendu idempotent.
4. **Cas Google** : écran de collecte **skippable** (« Plus tard ») — on n'empêche pas l'accès
   à l'app si l'utilisateur ne donne pas son numéro.
5. **Best-effort** : aucun envoi (SMS/email) ne doit jamais faire échouer une inscription, une
   connexion ou une mise à jour de profil.
6. **Mode simulé** : sans clés de fournisseur, l'envoi est loggé et renvoie `true` (aucun coût,
   aucune erreur) — permet un déploiement progressif.

## 6. Modèle de données

Migration Prisma (deux colonnes nullables, `ADD COLUMN` instantané, pas de backfill) :

```prisma
model User {
  // ... champs existants ...
  welcomeEmailSentAt DateTime?   // horodatage d'envoi de l'email de bienvenue
  welcomeSmsSentAt   DateTime?   // horodatage d'envoi du SMS de bienvenue
}
```

Commande : `npx prisma migrate dev --name add_welcome_flags` (dev) / `migrate deploy` (Render).

## 7. Composants — Backend (`lilia-backend`)

### 7.1 `SmsService` réécrit sur Infobip
`modules/sms/sms.service.ts`

- Dépendance : `npm i @infobip-api/sdk`.
- Init dans le constructeur (ou `onModuleInit`) :
  - lit `INFOBIP_API_KEY`, `INFOBIP_BASE_URL`, `INFOBIP_SENDER`.
  - `isEnabled = !!(apiKey && baseUrl)`. Si désactivé → mode simulé (log + `return true`).
  - client : `new Infobip({ baseUrl, apiKey, authType: AuthType.ApiKey })`.
- API publique conservée minimale :
  - `async send(to: string, message: string): Promise<boolean>` — formate le numéro en
    E.164 `+242…` (`formatNumber` conservé), envoie via
    `client.channels.sms.send({ messages: [{ from: sender, destinations: [{ to }], text: message }] })`
    (forme exacte alignée sur le SDK installé), log succès/échec, ne jette jamais.
  - `async sendWelcome(phone: string, nom: string): Promise<boolean>` — message **sans accents,
    1 segment** :
    `Bienvenue ${nom} sur Lilia Food ! Commandez vos repas preferes a Brazzaville. A tres vite !`
    (tronquer `nom` si nécessaire pour rester < 160 caractères).
- **Nettoyage** : suppression des helpers liés aux commandes désormais hors périmètre
  (`sendOrderConfirmation`, `sendDeliveryAssigned`, `sendDeliveryIncoming`) — ils n'étaient
  appelés nulle part.

### 7.2 `SmsModule`
`modules/sms/sms.module.ts` — ajouter `exports: [SmsService]` pour permettre l'injection dans
`UserListener` (provider global d'`AppModule`).

### 7.3 `UserListener` — cœur de la feature
`modules/listeners/user.listener.ts` (aujourd'hui vide). Injecte `EmailService`, `SmsService`,
`PrismaService`.

- `@OnEvent('user.created')` `handleUserCreated(event: UserCreatedEvent)` :
  1. charge l'utilisateur (`email, nom, phone, welcomeEmailSentAt, welcomeSmsSentAt`).
  2. **Email** : si `email && !welcomeEmailSentAt && emailService.isReady()` →
     `sendWelcomeEmail(email, nom ?? email.split('@')[0])` ; si succès, `update welcomeEmailSentAt = now()`.
  3. **SMS** : si `phone && !welcomeSmsSentAt` → `sendWelcome(phone, nom ?? 'client')` ;
     si succès, `update welcomeSmsSentAt = now()`. *(couvre l'inscription email/password)*
  4. tout en `try/catch`, jamais bloquant.
- `@OnEvent('user.phone.completed')` `handlePhoneCompleted({ userId })` :
  1. charge l'utilisateur (`phone, nom, welcomeSmsSentAt, createdAt`).
  2. si `phone && !welcomeSmsSentAt && createdAt > now - 24h` → `sendWelcome` + set flag.
     *(couvre le cas Google : numéro complété après la création)*
  3. la fenêtre 24 h évite d'envoyer un SMS « bienvenue » à un ancien client qui modifierait
     simplement son numéro plus tard ; le flag garantit l'unicité.

### 7.4 Émission `user.phone.completed`
`modules/users/users.service.ts` — dans `updateUser`, après le `prisma.user.update`, si le DTO
contient un `phone` non vide, émettre `this.eventEmitter.emit('user.phone.completed', { userId: id })`.
Le filtrage métier (flag + fenêtre) est fait par le listener, donc émettre à chaque mise à jour
de numéro est sans risque (idempotent). Définir l'event dans `modules/events/user-events.ts`
(`UserPhoneCompletedEvent { userId }`).

### 7.5 Suppression du code mort
- Supprimer `modules/listeners/email.listener.ts` (welcome email déplacé en 7.3 ; email
  « nouveau menu » inactif et hors périmètre).
- Corriger/retirer le commentaire trompeur ligne 59 d'`app.module.ts`.
- `UserListener` est déjà enregistré dans `app.module.ts` (providers globaux) — vérifier que
  `EmailModule` et `SmsModule` sont importés (EmailModule l'est ; SmsModule l'est, ajouter
  l'export en 7.2).

### 7.6 Variables d'environnement
Retirer : `AFRICAS_TALKING_API_KEY`, `AFRICAS_TALKING_USERNAME`, `SMS_SENDER_ID`.
Ajouter :
```env
INFOBIP_API_KEY=
INFOBIP_BASE_URL=          # ex: xxxxx.api.infobip.com (propre au compte)
INFOBIP_SENDER=LiliaFood   # sender ID alphanumérique enregistré
```
Mettre à jour `config/env.validation.ts` en conséquence. Mailtrap inchangé
(`MAILTRAP_API_TOKEN`, `MAILTRAP_SENDER_EMAIL`, `MAILTRAP_SENDER_NAME`).

## 8. Composant — Flutter (`lilia-app`)

Écran/bottom-sheet **skippable** de collecte du numéro après une connexion Google sans numéro.

- Déclenchement : après `signInWithGoogle()` réussi, si l'utilisateur n'a pas de numéro
  (`AppUser.phone` vide/null), afficher le bottom-sheet « Ajoute ton numéro pour le suivi de
  tes commandes ».
- Champ téléphone (validation format local), bouton **Enregistrer** et bouton **Plus tard**
  (skip, ferme et continue vers le home).
- Enregistrement : `PUT /users/me { phone }` (endpoint et DTO existants) → côté backend,
  `updateUser` émet `user.phone.completed` → SMS de bienvenue.
- Best-effort UI : un échec réseau ne bloque pas l'accès à l'app.

## 9. Flux de données

**Inscription email/password :**
`signup → /users/sync (telephone présent) → user créé + emit user.created`
`→ UserListener : email de bienvenue + SMS de bienvenue` (les deux flags posés).

**Connexion Google :**
`signInWithGoogle → /users/sync (telephone null) → user créé + emit user.created`
`→ UserListener : email de bienvenue uniquement` (welcomeEmailSentAt posé, pas de SMS).
`→ bottom-sheet skippable → PUT /users/me { phone } → emit user.phone.completed`
`→ UserListener : SMS de bienvenue` (welcomeSmsSentAt posé).
Si l'utilisateur « passe », aucun SMS — comportement attendu.

## 10. Gestion d'erreurs

- `SmsService.send` / `EmailService.sendEmail` : `try/catch`, log, **renvoient `false`**,
  ne jettent jamais.
- Les handlers de `UserListener` enveloppent tout en `try/catch` et n'affectent jamais le flux
  appelant (l'émission d'event est déjà découplée).
- Les flags ne sont posés **que** sur envoi réussi (`true`) → un échec sera réessayé au prochain
  déclencheur éligible plutôt que silencieusement « consommé ».
- Mode simulé (sans clés) : `send` renvoie `true` et le flag est posé (comportement voulu en
  environnement sans fournisseur, évite des relances inutiles).

## 11. Tests

- **Smoke DI** : `UserListener` instanciable avec mocks `EmailService` / `SmsService` /
  `PrismaService`.
- **Idempotence email** : `welcomeEmailSentAt` déjà posé → `sendWelcomeEmail` non appelé.
- **Idempotence SMS** : `welcomeSmsSentAt` déjà posé → `sendWelcome` non appelé.
- **Cas email/password** : `user.created` avec `phone` → email + SMS, deux flags posés.
- **Cas Google** : `user.created` sans `phone` → email seul ; puis `user.phone.completed`
  (createdAt récent) → SMS posé.
- **Fenêtre 24 h** : `user.phone.completed` avec `createdAt` ancien → pas de SMS.
- **`SmsService` mode simulé** : sans clés, `send` renvoie `true` sans appeler le SDK.

## 12. Points opérationnels (hors code)

- **Confirmer le tarif Infobip vers +242** dans le portail (pay-as-you-go, tarif par pays) et
  recalculer le coût avec la formule du §3.
- **Enregistrer le sender ID alphanumérique « LiliaFood »** sur le portail Infobip (certains
  pays exigent un enregistrement préalable ; sinon repli sur sender numérique).
- Définir `INFOBIP_API_KEY` / `INFOBIP_BASE_URL` / `INFOBIP_SENDER` sur Render. Tant qu'ils ne
  sont pas définis, le SMS reste en mode simulé sans effet de bord.

## 13. Dette / suivi

- Le commentaire historique d'`app.module.ts` sur `EmailListener` est nettoyé par cette feature.
- Si l'email « nouveau menu » est souhaité ultérieurement, le recâbler proprement dans
  `MenusListener` (feature séparée), au lieu de ressusciter `email.listener.ts`.
