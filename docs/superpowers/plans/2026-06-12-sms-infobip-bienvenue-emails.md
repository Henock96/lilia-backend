# SMS de bienvenue (Infobip) & email de bienvenue (Mailtrap) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Envoyer un email (Mailtrap) et un SMS (Infobip) de bienvenue, une seule fois, à la première inscription d'un client — y compris le cas Google où le numéro est saisi après coup — sans toucher aux notifications de commande FCM.

**Architecture :** Événementiel NestJS. `UserListener` écoute `user.created` (email + SMS si numéro présent) et `user.phone.completed` (SMS quand le numéro est complété après une connexion Google). Idempotence garantie par deux flags `User.welcomeEmailSentAt` / `welcomeSmsSentAt`. `SmsService` est l'unique point de couture vers Infobip. Côté Flutter, un bottom-sheet skippable collecte le numéro après Google et appelle `PUT /users/me`.

**Tech Stack :** NestJS 11 + Prisma 7 + PostgreSQL + `@nestjs/event-emitter` + `@infobip-api/sdk` + `mailtrap` (backend) ; Flutter + Riverpod (lilia-app). Tests : Jest 30 (`@nestjs/testing`).

**Spec de référence :** `docs/superpowers/specs/2026-06-12-sms-infobip-bienvenue-emails-design.md`

**Repos & commits :** Deux repos git distincts (`lilia-backend`, `lilia-app`). Conformément à la préférence utilisateur (commit unique par arbre), on fait **un seul commit par repo** : à la fin de la Phase A pour `lilia-backend`, à la fin de la Phase B pour `lilia-app`.

**Convention de test backend :** lancer un fichier précis avec `npx jest <chemin-relatif-au-repo>` depuis la racine `lilia-backend/`.

---

## Carte des fichiers

**Backend — `lilia-backend/`**
| Fichier | Rôle | Action |
|---|---|---|
| `prisma/schema.prisma` | Modèle `User` | Modifier (2 champs) |
| `apps/lilia-app/src/modules/sms/sms.service.ts` | Envoi SMS Infobip | Réécrire |
| `apps/lilia-app/src/modules/sms/sms.service.spec.ts` | Tests SmsService | Créer |
| `apps/lilia-app/src/modules/sms/sms.module.ts` | Module SMS | Modifier (export) |
| `apps/lilia-app/src/modules/events/user-events.ts` | Définition events user | Modifier (nouvel event) |
| `apps/lilia-app/src/modules/users/users.service.ts` | `updateUser` émet l'event | Modifier |
| `apps/lilia-app/src/modules/listeners/user.listener.ts` | Logique bienvenue | Réécrire |
| `apps/lilia-app/src/modules/listeners/user.listener.spec.ts` | Tests UserListener | Créer |
| `apps/lilia-app/src/modules/listeners/email.listener.ts` | Code mort | Supprimer |
| `apps/lilia-app/src/app.module.ts` | Commentaire trompeur | Modifier |
| `apps/lilia-app/src/config/env.validation.ts` | Vars d'env | Modifier |
| `.env.example` | Vars d'env doc | Modifier |

**Frontend — `lilia-app/`**
| Fichier | Rôle | Action |
|---|---|---|
| `lib/features/auth/presentation/phone_collection_sheet.dart` | Bottom-sheet + helper | Créer |
| `lib/features/auth/presentation/phone_collection_sheet_test.dart` (sous `test/`) | Test widget | Créer |
| `lib/features/auth/presentation/signin_page.dart` | Déclencheur post-Google | Modifier |

---

# Phase A — Backend (`lilia-backend/`)

## Task 1 : Installer le SDK Infobip

**Files:**
- Modify: `package.json` (via npm)

- [ ] **Step 1 : Installer la dépendance**

Run (depuis `lilia-backend/`) :
```bash
npm install @infobip-api/sdk
```
Expected : `package.json` gagne `@infobip-api/sdk` dans `dependencies`, pas d'erreur d'install.

- [ ] **Step 2 : Vérifier l'import du SDK**

Run :
```bash
node -e "const s=require('@infobip-api/sdk'); console.log(typeof s.Infobip, typeof s.AuthType)"
```
Expected : `function object` (ou `function function`) — confirme que `Infobip` et `AuthType` sont exportés.

---

## Task 2 : Flags d'idempotence sur `User` (migration Prisma)

**Files:**
- Modify: `prisma/schema.prisma` (modèle `User`)

- [ ] **Step 1 : Ajouter les deux colonnes au modèle `User`**

Dans `model User { ... }`, ajouter près des autres champs scalaires :
```prisma
  welcomeEmailSentAt DateTime?
  welcomeSmsSentAt   DateTime?
```

- [ ] **Step 2 : Créer et appliquer la migration**

Run :
```bash
npx prisma migrate dev --name add_welcome_flags
```
Expected : nouvelle migration sous `prisma/migrations/<timestamp>_add_welcome_flags/`, client Prisma régénéré, pas d'erreur.

- [ ] **Step 3 : Vérifier que le client typé connaît les champs**

Run :
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected : aucune erreur (les champs seront référencés plus tard ; ici on valide juste la génération).

---

## Task 3 : Réécrire `SmsService` sur Infobip (TDD)

**Files:**
- Create: `apps/lilia-app/src/modules/sms/sms.service.spec.ts`
- Modify (réécriture): `apps/lilia-app/src/modules/sms/sms.service.ts`

- [ ] **Step 1 : Écrire les tests (mode simulé, sans clés)**

Créer `apps/lilia-app/src/modules/sms/sms.service.spec.ts` :
```ts
import { ConfigService } from '@nestjs/config';
import { SmsService } from './sms.service';

const makeConfig = (values: Record<string, any>): ConfigService =>
  ({ get: (k: string, d?: any) => values[k] ?? d }) as unknown as ConfigService;

describe('SmsService (mode simulé)', () => {
  it('send() renvoie true sans client quand les clés manquent', async () => {
    const service = new SmsService(makeConfig({}));
    await expect(service.send('061234567', 'test')).resolves.toBe(true);
  });

  it('sendWelcome() reste sur 1 segment GSM-7 (<160 caractères, sans accents)', async () => {
    const service = new SmsService(makeConfig({}));
    const spy = jest.spyOn(service, 'send');
    await service.sendWelcome('061234567', 'Jean');
    const message = spy.mock.calls[0][1];
    expect(message.length).toBeLessThanOrEqual(160);
    expect(message).not.toMatch(/[éèàùâêîôûçëïü]/i);
  });

  it('sendWelcome() tronque un nom très long', async () => {
    const service = new SmsService(makeConfig({}));
    const spy = jest.spyOn(service, 'send');
    await service.sendWelcome('061234567', 'Jean-Baptiste-Emmanuel-Tres-Long');
    const message = spy.mock.calls[0][1];
    expect(message.length).toBeLessThanOrEqual(160);
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run :
```bash
npx jest apps/lilia-app/src/modules/sms/sms.service.spec.ts
```
Expected : FAIL (l'ancien `SmsService` n'a pas `sendWelcome`, et l'init Africa's Talking est cassée).

- [ ] **Step 3 : Réécrire `sms.service.ts`**

Remplacer **tout** le contenu de `apps/lilia-app/src/modules/sms/sms.service.ts` par :
```ts
// sms/sms.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Infobip, AuthType } from '@infobip-api/sdk';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly isEnabled: boolean;
  private readonly sender: string;
  private client: Infobip | null = null;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('INFOBIP_API_KEY');
    const baseUrl = this.config.get<string>('INFOBIP_BASE_URL');
    this.sender = this.config.get<string>('INFOBIP_SENDER', 'LiliaFood');
    this.isEnabled = !!(apiKey && baseUrl);

    if (this.isEnabled) {
      this.client = new Infobip({
        baseUrl: baseUrl as string,
        apiKey: apiKey as string,
        authType: AuthType.ApiKey,
      });
      this.logger.log('SMS service initialise (Infobip)');
    } else {
      this.logger.warn('SMS service desactive — INFOBIP_API_KEY/INFOBIP_BASE_URL manquant');
    }
  }

  /**
   * Envoie un SMS. En mode simule (sans cles) : log uniquement, renvoie true, aucun cout.
   * Ne jette jamais : renvoie false en cas d'echec reel.
   */
  async send(to: string, message: string): Promise<boolean> {
    if (!this.isEnabled || !this.client) {
      this.logger.debug(`[SMS simule] -> ${to} : ${message}`);
      return true;
    }
    try {
      const formatted = this.formatNumber(to);
      await this.client.channels.sms.send({
        messages: [
          { destinations: [{ to: formatted }], from: this.sender, text: message },
        ],
      });
      this.logger.log(`SMS envoye -> ${formatted}`);
      return true;
    } catch (error) {
      this.logger.error(`Echec SMS -> ${to}: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * SMS de bienvenue. Message sans accents et < 160 caracteres => 1 segment GSM-7.
   */
  async sendWelcome(phone: string, nom: string): Promise<boolean> {
    const safeName = (nom || 'client').trim().slice(0, 20);
    return this.send(
      phone,
      `Bienvenue ${safeName} sur Lilia Food ! Commandez vos plats preferes a Brazzaville. A tres vite !`,
    );
  }

  private formatNumber(phone: string): string {
    let cleaned = phone.replace(/\s+/g, '').replace(/^\+/, '');
    if (!cleaned.startsWith('242')) cleaned = `242${cleaned}`;
    return `+${cleaned}`;
  }
}
```

- [ ] **Step 4 : Lancer les tests pour vérifier qu'ils passent**

Run :
```bash
npx jest apps/lilia-app/src/modules/sms/sms.service.spec.ts
```
Expected : PASS (3 tests verts).

> Note : si le SDK installé expose une signature différente de `client.channels.sms.send(...)`, vérifier dans `node_modules/@infobip-api/sdk` et adapter **uniquement** le corps du `try` ; la forme `{ messages: [{ destinations:[{to}], from, text }] }` correspond à l'endpoint `/sms/2/text/advanced`.

---

## Task 4 : Exporter `SmsService` depuis `SmsModule`

**Files:**
- Modify: `apps/lilia-app/src/modules/sms/sms.module.ts`

- [ ] **Step 1 : Ajouter `exports`**

Remplacer le contenu par :
```ts
import { Module } from '@nestjs/common';
import { SmsService } from './sms.service';

@Module({
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
```

- [ ] **Step 2 : Vérifier la compilation**

Run :
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected : aucune erreur.

---

## Task 5 : Nouvel event `user.phone.completed`

**Files:**
- Modify: `apps/lilia-app/src/modules/events/user-events.ts`

- [ ] **Step 1 : Ajouter la classe d'event**

À la fin de `apps/lilia-app/src/modules/events/user-events.ts`, ajouter :
```ts
export class UserPhoneCompletedEvent {
  constructor(public readonly userId: string) {}
}
```

- [ ] **Step 2 : Vérifier la compilation**

Run :
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected : aucune erreur.

---

## Task 6 : `UserService.updateUser` émet `user.phone.completed`

**Files:**
- Modify: `apps/lilia-app/src/modules/users/users.service.ts`

- [ ] **Step 1 : Importer le nouvel event**

Dans les imports, à côté de `import { UserCreatedEvent } from '../events/user-events';`, étendre :
```ts
import { UserCreatedEvent, UserPhoneCompletedEvent } from '../events/user-events';
```

- [ ] **Step 2 : Émettre l'event si un numéro est fourni**

Remplacer la méthode `updateUser` par :
```ts
  async updateUser(id: string, data: UpdateUserDto): Promise<User> {
    const updated = await this.prisma.user.update({
      where: { id },
      data,
    });
    await this.userCache.invalidate(updated.firebaseUid);
    // Numero (re)saisi via PUT /users/me — declenche le SMS de bienvenue cote
    // Google. Le UserListener filtre via le flag welcomeSmsSentAt + fenetre 24h,
    // donc emettre a chaque mise a jour de numero est idempotent.
    if (data.phone && data.phone.trim().length > 0) {
      this.eventEmitter.emit('user.phone.completed', new UserPhoneCompletedEvent(id));
    }
    return updated;
  }
```

- [ ] **Step 3 : Vérifier la compilation**

Run :
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected : aucune erreur (`this.eventEmitter` existe déjà comme dépendance du service).

---

## Task 7 : `UserListener` — bienvenue email + SMS (TDD)

**Files:**
- Create: `apps/lilia-app/src/modules/listeners/user.listener.spec.ts`
- Modify (réécriture): `apps/lilia-app/src/modules/listeners/user.listener.ts`

- [ ] **Step 1 : Écrire les tests**

Créer `apps/lilia-app/src/modules/listeners/user.listener.spec.ts` :
```ts
import { UserListener } from './user.listener';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { SmsService } from '../sms/sms.service';
import { UserCreatedEvent, UserPhoneCompletedEvent } from '../events/user-events';

describe('UserListener', () => {
  let listener: UserListener;
  let prisma: any;
  let email: any;
  let sms: any;

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) } };
    email = { isReady: jest.fn().mockReturnValue(true), sendWelcomeEmail: jest.fn().mockResolvedValue(true) };
    sms = { sendWelcome: jest.fn().mockResolvedValue(true) };
    listener = new UserListener(prisma as PrismaService, email as EmailService, sms as SmsService);
  });

  describe('user.created', () => {
    it('envoie email + SMS et pose les deux flags quand email et phone sont présents', async () => {
      prisma.user.findUnique.mockResolvedValue({
        email: 'jean@example.com', nom: 'Jean', phone: '061234567',
        welcomeEmailSentAt: null, welcomeSmsSentAt: null,
      });
      await listener.handleUserCreated(new UserCreatedEvent('u1', 'Jean', new Date()));
      expect(email.sendWelcomeEmail).toHaveBeenCalledWith('jean@example.com', 'Jean');
      expect(sms.sendWelcome).toHaveBeenCalledWith('061234567', 'Jean');
      expect(prisma.user.update).toHaveBeenCalledTimes(2);
    });

    it('envoie seulement l\'email quand il n\'y a pas de numéro (cas Google)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        email: 'g@example.com', nom: 'Gina', phone: '',
        welcomeEmailSentAt: null, welcomeSmsSentAt: null,
      });
      await listener.handleUserCreated(new UserCreatedEvent('u2', 'Gina', new Date()));
      expect(email.sendWelcomeEmail).toHaveBeenCalledTimes(1);
      expect(sms.sendWelcome).not.toHaveBeenCalled();
    });

    it('idempotence : n\'envoie pas si les flags sont déjà posés', async () => {
      prisma.user.findUnique.mockResolvedValue({
        email: 'a@b.com', nom: 'A', phone: '061111111',
        welcomeEmailSentAt: new Date(), welcomeSmsSentAt: new Date(),
      });
      await listener.handleUserCreated(new UserCreatedEvent('u3', 'A', new Date()));
      expect(email.sendWelcomeEmail).not.toHaveBeenCalled();
      expect(sms.sendWelcome).not.toHaveBeenCalled();
    });
  });

  describe('user.phone.completed', () => {
    it('envoie le SMS si numéro présent, flag absent, compte récent', async () => {
      prisma.user.findUnique.mockResolvedValue({
        nom: 'Gina', phone: '061234567', welcomeSmsSentAt: null, createdAt: new Date(),
      });
      await listener.handlePhoneCompleted(new UserPhoneCompletedEvent('u2'));
      expect(sms.sendWelcome).toHaveBeenCalledWith('061234567', 'Gina');
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('n\'envoie pas si le compte est ancien (> 24h)', async () => {
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      prisma.user.findUnique.mockResolvedValue({
        nom: 'Vieux', phone: '061234567', welcomeSmsSentAt: null, createdAt: old,
      });
      await listener.handlePhoneCompleted(new UserPhoneCompletedEvent('u4'));
      expect(sms.sendWelcome).not.toHaveBeenCalled();
    });

    it('n\'envoie pas si le SMS de bienvenue est déjà parti', async () => {
      prisma.user.findUnique.mockResolvedValue({
        nom: 'X', phone: '061234567', welcomeSmsSentAt: new Date(), createdAt: new Date(),
      });
      await listener.handlePhoneCompleted(new UserPhoneCompletedEvent('u5'));
      expect(sms.sendWelcome).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run :
```bash
npx jest apps/lilia-app/src/modules/listeners/user.listener.spec.ts
```
Expected : FAIL (`UserListener` actuel n'a ni `handleUserCreated` ni `handlePhoneCompleted` et son constructeur diffère).

- [ ] **Step 3 : Réécrire `user.listener.ts`**

Remplacer **tout** le contenu de `apps/lilia-app/src/modules/listeners/user.listener.ts` par :
```ts
/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { SmsService } from '../sms/sms.service';
import { UserCreatedEvent, UserPhoneCompletedEvent } from '../events/user-events';

@Injectable()
export class UserListener {
  private readonly logger = new Logger(UserListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
  ) {}

  /** Bienvenue à la création du compte : email (toujours) + SMS (si numéro présent). */
  @OnEvent('user.created')
  async handleUserCreated(event: UserCreatedEvent): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: event.userId },
        select: {
          email: true, nom: true, phone: true,
          welcomeEmailSentAt: true, welcomeSmsSentAt: true,
        },
      });
      if (!user) return;

      if (user.email && !user.welcomeEmailSentAt && this.emailService.isReady()) {
        const ok = await this.emailService.sendWelcomeEmail(
          user.email,
          user.nom || user.email.split('@')[0],
        );
        if (ok) {
          await this.prisma.user.update({
            where: { id: event.userId },
            data: { welcomeEmailSentAt: new Date() },
          });
        }
      }

      if (user.phone && !user.welcomeSmsSentAt) {
        const ok = await this.smsService.sendWelcome(user.phone, user.nom || 'client');
        if (ok) {
          await this.prisma.user.update({
            where: { id: event.userId },
            data: { welcomeSmsSentAt: new Date() },
          });
        }
      }
    } catch (error) {
      this.logger.error(
        `Erreur bienvenue (user.created) ${event.userId}: ${(error as Error).message}`,
      );
    }
  }

  /** Numéro complété après coup (cas Google) : SMS de bienvenue si compte récent. */
  @OnEvent('user.phone.completed')
  async handlePhoneCompleted(event: UserPhoneCompletedEvent): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: event.userId },
        select: { nom: true, phone: true, welcomeSmsSentAt: true, createdAt: true },
      });
      if (!user || !user.phone || user.welcomeSmsSentAt) return;

      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      if (user.createdAt < oneDayAgo) return;

      const ok = await this.smsService.sendWelcome(user.phone, user.nom || 'client');
      if (ok) {
        await this.prisma.user.update({
          where: { id: event.userId },
          data: { welcomeSmsSentAt: new Date() },
        });
      }
    } catch (error) {
      this.logger.error(
        `Erreur bienvenue (user.phone.completed) ${event.userId}: ${(error as Error).message}`,
      );
    }
  }
}
```

- [ ] **Step 4 : Lancer les tests pour vérifier qu'ils passent**

Run :
```bash
npx jest apps/lilia-app/src/modules/listeners/user.listener.spec.ts
```
Expected : PASS (6 tests verts).

---

## Task 8 : Supprimer le code mort & nettoyer `app.module.ts`

**Files:**
- Delete: `apps/lilia-app/src/modules/listeners/email.listener.ts`
- Modify: `apps/lilia-app/src/app.module.ts`

- [ ] **Step 1 : Confirmer que `email.listener.ts` n'est référencé nulle part**

Run :
```bash
grep -rn "email.listener\|EmailListener" apps/lilia-app/src
```
Expected : seulement le commentaire dans `app.module.ts` (aucun `import`/`provider`). Si un import existe, le retirer aussi à l'étape suivante.

- [ ] **Step 2 : Supprimer le fichier**

Run :
```bash
rm apps/lilia-app/src/modules/listeners/email.listener.ts
```

- [ ] **Step 3 : Corriger le commentaire trompeur**

Dans `apps/lilia-app/src/app.module.ts`, remplacer la ligne :
```ts
// EmailListener supprimé — logique déplacée dans UserListener
```
par :
```ts
// Email + SMS de bienvenue : gérés par UserListener (modules/listeners/user.listener.ts)
```

- [ ] **Step 4 : Vérifier la compilation**

Run :
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected : aucune erreur.

---

## Task 9 : Variables d'environnement (Infobip)

**Files:**
- Modify: `apps/lilia-app/src/config/env.validation.ts`
- Modify: `.env.example`

- [ ] **Step 1 : Remplacer les vars Africa's Talking par Infobip dans la validation**

Dans `apps/lilia-app/src/config/env.validation.ts`, remplacer :
```ts
  AFRICAS_TALKING_API_KEY: Joi.string().optional(),
  AFRICAS_TALKING_USERNAME: Joi.string().optional(),
  SMS_SENDER_ID: Joi.string().default('LiliaFood'),
```
par :
```ts
  INFOBIP_API_KEY: Joi.string().optional(),
  INFOBIP_BASE_URL: Joi.string().optional(),
  INFOBIP_SENDER: Joi.string().default('LiliaFood'),
```

- [ ] **Step 2 : Mettre à jour `.env.example`**

Dans `.env.example`, remplacer le bloc Africa's Talking (`AFRICAS_TALKING_API_KEY`, `AFRICAS_TALKING_USERNAME`, `SMS_SENDER_ID`) par :
```env
# SMS Infobip
INFOBIP_API_KEY=
INFOBIP_BASE_URL=          # ex: xxxxx.api.infobip.com (propre au compte Infobip)
INFOBIP_SENDER=LiliaFood   # sender ID alphanumerique enregistre sur le portail
```

- [ ] **Step 3 : Vérifier qu'aucune référence aux anciennes vars ne subsiste dans le code**

Run :
```bash
grep -rn "AFRICAS_TALKING\|SMS_SENDER_ID" apps/lilia-app/src || echo "OK: aucune reference"
```
Expected : `OK: aucune reference`.

---

## Task 10 : Vérification globale Phase A + commit unique

**Files:** (aucun nouveau)

- [ ] **Step 1 : Build complet + suite de tests SMS/listener**

Run :
```bash
npx tsc --noEmit -p tsconfig.json
npx jest apps/lilia-app/src/modules/sms/sms.service.spec.ts apps/lilia-app/src/modules/listeners/user.listener.spec.ts
```
Expected : compilation sans erreur, tous les tests verts.

- [ ] **Step 2 : Smoke test de démarrage (DI résolue)**

Run :
```bash
npm run build
```
Expected : build NestJS réussi (valide que `UserListener` résout bien `EmailService` + `SmsService`, et que `SmsModule` exporte `SmsService`).

- [ ] **Step 3 : Commit unique de la Phase A**

Run (depuis `lilia-backend/`) :
```bash
git add -A
git commit -m "feat(notifications): SMS + email de bienvenue (Infobip + Mailtrap)

- Bascule SMS d'Africa's Talking vers Infobip (couverture +242)
- UserListener: email (Mailtrap) + SMS (Infobip) de bienvenue, idempotents
- Flags User.welcomeEmailSentAt / welcomeSmsSentAt (migration)
- Event user.phone.completed pour le cas Google (numero saisi apres coup)
- Suppression du code mort email.listener.ts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected : un seul commit contenant toute la Phase A.

---

# Phase B — Frontend (`lilia-app/`)

> Les chemins ci-dessous sont relatifs à la racine du repo `lilia-app/`.
> Commande d'analyse : `flutter analyze` ; tests : `flutter test`.

## Task 11 : Bottom-sheet de collecte du numéro + helper (TDD léger)

**Files:**
- Create: `lib/features/auth/presentation/phone_collection_sheet.dart`
- Create: `test/features/auth/phone_collection_sheet_test.dart`

- [ ] **Step 1 : Écrire le widget + le helper**

Créer `lib/features/auth/presentation/phone_collection_sheet.dart` :
```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lilia_app/features/user/application/profile_controller.dart';

/// Affiche le bottom-sheet de collecte du numero si l'utilisateur connecte
/// n'a pas encore de numero. Skippable. A appeler apres une connexion Google.
Future<void> maybePromptPhoneNumber(BuildContext context, WidgetRef ref) async {
  try {
    final profile = await ref.read(userProfileProvider.future);
    final hasPhone = (profile.phone ?? '').trim().isNotEmpty;
    if (hasPhone || !context.mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useRootNavigator: true,
      builder: (_) => const PhoneCollectionSheet(),
    );
  } catch (_) {
    // Best-effort : ne jamais bloquer le flux de connexion.
  }
}

class PhoneCollectionSheet extends ConsumerStatefulWidget {
  const PhoneCollectionSheet({super.key});

  @override
  ConsumerState<PhoneCollectionSheet> createState() => _PhoneCollectionSheetState();
}

class _PhoneCollectionSheetState extends ConsumerState<PhoneCollectionSheet> {
  final _controller = TextEditingController();
  bool _saving = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final phone = _controller.text.trim();
    if (phone.isEmpty) return;
    setState(() => _saving = true);
    final ok = await ref
        .read(profileControllerProvider.notifier)
        .updateUser({'phone': phone});
    if (!mounted) return;
    setState(() => _saving = false);
    if (ok) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(24, 24, 24, 24 + bottomInset),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Ajoute ton numero',
              style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          const Text(
            'Pour le suivi de tes commandes et nos messages importants.',
          ),
          const SizedBox(height: 16),
          TextField(
            key: const Key('phone_collection_field'),
            controller: _controller,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(
              labelText: 'Numero de telephone',
              prefixIcon: Icon(Icons.phone_outlined),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton(
            key: const Key('phone_collection_save'),
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(
                    height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Enregistrer'),
          ),
          TextButton(
            key: const Key('phone_collection_skip'),
            onPressed: _saving ? null : () => Navigator.of(context).pop(),
            child: const Text('Plus tard'),
          ),
        ],
      ),
    );
  }
}
```

- [ ] **Step 2 : Écrire un test widget**

Créer `test/features/auth/phone_collection_sheet_test.dart` :
```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lilia_app/features/auth/presentation/phone_collection_sheet.dart';

void main() {
  testWidgets('affiche le champ, le bouton Enregistrer et le bouton Plus tard',
      (tester) async {
    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(
          home: Scaffold(body: PhoneCollectionSheet()),
        ),
      ),
    );

    expect(find.byKey(const Key('phone_collection_field')), findsOneWidget);
    expect(find.byKey(const Key('phone_collection_save')), findsOneWidget);
    expect(find.byKey(const Key('phone_collection_skip')), findsOneWidget);
  });

  testWidgets('le bouton Plus tard ferme la feuille (skippable)', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                onPressed: () => showModalBottomSheet<void>(
                  context: context,
                  builder: (_) => const PhoneCollectionSheet(),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('phone_collection_skip')), findsOneWidget);

    await tester.tap(find.byKey(const Key('phone_collection_skip')));
    await tester.pumpAndSettle();
    expect(find.byType(PhoneCollectionSheet), findsNothing);
  });
}
```

- [ ] **Step 3 : Lancer l'analyse et le test**

Run (depuis `lilia-app/`) :
```bash
flutter analyze lib/features/auth/presentation/phone_collection_sheet.dart
flutter test test/features/auth/phone_collection_sheet_test.dart
```
Expected : analyse sans erreur, 2 tests verts.

> Note : `profileControllerProvider`, `userProfileProvider` et `ProfileController.updateUser(Map)` existent déjà dans `lib/features/user/application/profile_controller.dart` (vérifié). Aucun code généré nouveau n'est requis ici (pas de `@riverpod` ajouté).

---

## Task 12 : Déclencher le bottom-sheet après une connexion Google

**Files:**
- Modify: `lib/features/auth/presentation/signin_page.dart`

- [ ] **Step 1 : Importer le helper**

En haut de `lib/features/auth/presentation/signin_page.dart`, ajouter l'import :
```dart
import 'package:lilia_app/features/auth/presentation/phone_collection_sheet.dart';
```

- [ ] **Step 2 : Appeler le helper après `signInWithGoogle()`**

Dans le widget `_SocialLogins`, le bouton Google (vers la ligne 258) a actuellement :
```dart
      onPressed: () async {
        await ref.read(authControllerProvider.notifier).signInWithGoogle();
      },
```
Le remplacer par :
```dart
      onPressed: () async {
        await ref.read(authControllerProvider.notifier).signInWithGoogle();
        final auth = ref.read(authControllerProvider);
        if (!auth.hasError && context.mounted) {
          // Numero absent du token Google => proposer de le saisir (skippable).
          await maybePromptPhoneNumber(context, ref);
        }
      },
```

> Si `_SocialLogins` n'est pas un `ConsumerWidget`/`ConsumerStatefulWidget` exposant `ref`, utiliser le `ref` déjà présent dans son `build` (le bouton Google y accède déjà via `ref.read(authControllerProvider.notifier)`, donc `ref` est en portée).

- [ ] **Step 3 : Analyse statique**

Run :
```bash
flutter analyze lib/features/auth/presentation/signin_page.dart
```
Expected : aucune erreur.

---

## Task 13 : Vérification globale Phase B + commit unique

**Files:** (aucun nouveau)

- [ ] **Step 1 : Analyse complète + tests d'auth**

Run (depuis `lilia-app/`) :
```bash
flutter analyze
flutter test test/features/auth/
```
Expected : analyse propre, tests verts.

- [ ] **Step 2 : Commit unique de la Phase B**

Run (depuis `lilia-app/`) :
```bash
git add -A
git commit -m "feat(auth): collecte skippable du numero apres connexion Google

- PhoneCollectionSheet + helper maybePromptPhoneNumber
- Declenche apres signInWithGoogle si le profil n'a pas de numero
- PUT /users/me => SMS de bienvenue cote backend (user.phone.completed)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected : un seul commit contenant toute la Phase B.

---

## Auto-revue du plan (couverture spec)

- §6 Modèle de données → **Task 2** ✅
- §7.1 SmsService Infobip → **Task 1, 3** ✅
- §7.2 SmsModule exports → **Task 4** ✅
- §7.3 UserListener (email + SMS, idempotent, fenêtre 24h) → **Task 7** ✅
- §7.4 Event user.phone.completed → **Task 5, 6** ✅
- §7.5 Suppression code mort + commentaire app.module → **Task 8** ✅
- §7.6 Variables d'environnement Infobip → **Task 9** ✅
- §8 Flutter bottom-sheet skippable → **Task 11, 12** ✅
- §10 Best-effort (try/catch, flags sur succès uniquement) → couvert dans **Task 3, 7, 11** ✅
- §11 Tests (smoke DI, idempotence, mode simulé, fenêtre 24h) → **Task 3, 7, 11** ✅
- §12 Points opérationnels (tarif +242, sender ID, vars Render) → hors code, rappelés dans la spec ✅

Aucun placeholder ; signatures cohérentes (`send`, `sendWelcome`, `handleUserCreated`,
`handlePhoneCompleted`, `UserPhoneCompletedEvent`, `maybePromptPhoneNumber`,
`updateUser(Map)`) entre tâches.
