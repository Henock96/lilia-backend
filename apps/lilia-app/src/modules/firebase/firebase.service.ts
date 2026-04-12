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
}