/* eslint-disable prettier/prettier */
// firebase/firebase.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { App, Credential, cert, getApps, initializeApp } from 'firebase-admin/app';
import { Auth, getAuth } from 'firebase-admin/auth';
import { Messaging, getMessaging } from 'firebase-admin/messaging';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private app: App;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const existing = getApps();
    if (existing.length > 0) {
      this.app = existing[0]!;
      this.logger.log('Firebase Admin SDK — instance existante réutilisée');
      return;
    }

    const credential = this.buildCredential();

    this.app = initializeApp({
      credential,
      projectId: this.config.get<string>('FIREBASE_PROJECT_ID'),
    });

    this.logger.log('Firebase Admin SDK initialisé');
  }

  private buildCredential(): Credential {
    const accountPath = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_PATH');

    if (accountPath) {
      // ✅ Résolution du chemin absolu depuis la racine du projet
      const absolutePath = resolve(process.cwd(), accountPath);

      if (!existsSync(absolutePath)) {
        throw new Error(
          `Fichier service account introuvable : ${absolutePath}\n` +
          `Vérifie FIREBASE_SERVICE_ACCOUNT_PATH dans ton .env`,
        );
      }

      // ✅ fs.readFileSync + JSON.parse — fonctionne avec webpack
      const serviceAccount = JSON.parse(readFileSync(absolutePath, 'utf-8'));
      this.logger.log('Credential Firebase : fichier service account');
      return cert(serviceAccount);
    }

    // Variables d'environnement (production Render)
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL');
    const rawKey = this.config.get<string>('FIREBASE_PRIVATE_KEY');

    if (!projectId || !clientEmail || !rawKey) {
      throw new Error(
        'Firebase non configuré. Définis FIREBASE_SERVICE_ACCOUNT_PATH ' +
        'ou les 3 variables FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.',
      );
    }

    this.logger.log('Credential Firebase : variables d\'environnement');
    return cert({
      projectId,
      clientEmail,
      privateKey: rawKey.replace(/\\n/g, '\n'),
    });
  }

  getAuth(): Auth {
    return getAuth(this.app);
  }

  getMessaging(): Messaging {
    return getMessaging(this.app);
  }

  isReady(): boolean {
    return !!this.app;
  }

  async revokeUserTokens(uid: string): Promise<void> {
    await getAuth(this.app).revokeRefreshTokens(uid);
    this.logger.warn(`Tokens révoqués pour : ${uid}`);
  }

  /**
   * Active / désactive un compte Firebase Auth.
   *
   * `revokeRefreshTokens` seul ne suffit pas à bannir : l'utilisateur peut se
   * reconnecter et obtenir un token frais. `disabled: true` bloque aussi la
   * ré-authentification — c'est ce qui rend le ban effectif côté Firebase.
   */
  async setUserDisabled(uid: string, disabled: boolean): Promise<void> {
    await getAuth(this.app).updateUser(uid, { disabled });
    this.logger.warn(
      `Compte Firebase ${disabled ? 'désactivé' : 'réactivé'} : ${uid}`,
    );
  }

  /**
   * Crée un user Firebase Auth (LIL-118).
   * Utilisé par AdminService.createRestaurantWithOwner pour qu'un admin
   * puisse onboard un nouveau vendeur sans devoir aller dans la Console.
   *
   * Lève FirebaseAuthError (code `auth/email-already-exists`, etc.) que
   * l'appelant doit attraper et convertir en BadRequestException claire.
   */
  async createUser(params: {
    email: string;
    password: string;
    displayName?: string;
    phoneNumber?: string;
  }): Promise<string> {
    const userRecord = await getAuth(this.app).createUser({
      email: params.email,
      password: params.password,
      displayName: params.displayName,
      // phoneNumber Firebase exige le format E.164 strict ; on l'omet
      // si non fourni pour éviter les rejets sur des numéros locaux.
      ...(params.phoneNumber && { phoneNumber: params.phoneNumber }),
      emailVerified: false,
      disabled: false,
    });
    this.logger.log(`User Firebase créé : ${userRecord.uid} (${params.email})`);
    return userRecord.uid;
  }

  /**
   * Génère un lien de définition de mot de passe pour une adresse existante.
   *
   * C'est ce qui permet à un administrateur de créer un compte vendeur sans
   * jamais en connaître le secret : le compte naît avec un mot de passe
   * jetable, et ce lien — signé par Firebase, à usage unique, à durée limitée —
   * laisse le vendeur définir le sien.
   *
   * ⚠️ Le SDK Admin **génère** le lien, il ne l'envoie pas. L'acheminement
   * (e-mail, SMS) est à la charge de l'appelant : voir `VendorInvitationService`.
   */
  async generatePasswordResetLink(email: string): Promise<string> {
    const link = await getAuth(this.app).generatePasswordResetLink(email);
    // L'URL porte un `oobCode` à usage unique : la journaliser reviendrait à
    // laisser un jeton de prise de contrôle du compte dans les logs.
    this.logger.log(`Lien d'activation généré pour ${email}`);
    return link;
  }

  /**
   * Supprime un user Firebase Auth — utilisé pour rollback en cas d'échec
   * de la transaction Prisma post-création (LIL-118). Best effort : on log
   * l'erreur mais on ne la propage pas pour ne pas masquer l'erreur d'origine.
   */
  async deleteUserSafe(uid: string): Promise<void> {
    try {
      await getAuth(this.app).deleteUser(uid);
      this.logger.warn(`User Firebase rollback supprimé : ${uid}`);
    } catch (err) {
      this.logger.error(
        `Échec rollback Firebase user ${uid} — à nettoyer manuellement`,
        err,
      );
    }
  }
}