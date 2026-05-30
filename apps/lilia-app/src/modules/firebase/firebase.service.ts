/* eslint-disable prettier/prettier */
// firebase/firebase.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as admin from 'firebase-admin';
import { Auth } from 'firebase-admin/auth';
import { Messaging } from 'firebase-admin/messaging';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private app: admin.app.App;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    if (admin.apps.length > 0) {
      this.app = admin.apps[0]!;
      this.logger.log('Firebase Admin SDK — instance existante réutilisée');
      return;
    }

    const credential = this.buildCredential();

    this.app = admin.initializeApp({
      credential,
      projectId: this.config.get<string>('FIREBASE_PROJECT_ID'),
    });

    this.logger.log('Firebase Admin SDK initialisé');
  }

  private buildCredential(): admin.credential.Credential {
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
      return admin.credential.cert(serviceAccount);
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
    return admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: rawKey.replace(/\\n/g, '\n'),
    });
  }

  getAuth(): Auth {
    return this.app.auth();
  }

  getMessaging(): Messaging {
    return this.app.messaging();
  }

  isReady(): boolean {
    return !!this.app;
  }

  async revokeUserTokens(uid: string): Promise<void> {
    await this.app.auth().revokeRefreshTokens(uid);
    this.logger.warn(`Tokens révoqués pour : ${uid}`);
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
    const userRecord = await this.app.auth().createUser({
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
   * Supprime un user Firebase Auth — utilisé pour rollback en cas d'échec
   * de la transaction Prisma post-création (LIL-118). Best effort : on log
   * l'erreur mais on ne la propage pas pour ne pas masquer l'erreur d'origine.
   */
  async deleteUserSafe(uid: string): Promise<void> {
    try {
      await this.app.auth().deleteUser(uid);
      this.logger.warn(`User Firebase rollback supprimé : ${uid}`);
    } catch (err) {
      this.logger.error(
        `Échec rollback Firebase user ${uid} — à nettoyer manuellement`,
        err,
      );
    }
  }
}