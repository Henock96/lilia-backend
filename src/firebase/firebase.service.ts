/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private isInitialized = false;
  private initializationError: Error | null = null;

  async onModuleInit() {
    await this.initializeFirebase();
  }

  private async initializeFirebase() {
    if (admin.apps.length > 0) {
      this.logger.log('Firebase Admin SDK already initialized');
      this.isInitialized = true;
      return;
    }

    try {
      this.logger.log('Initializing Firebase Admin SDK...');

      let credential: admin.credential.Credential;

      // Option 1: Utiliser le chemin vers le fichier JSON (pour le dev local)
      if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
        const serviceAccountPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);

        if (!fs.existsSync(serviceAccountPath)) {
          throw new Error(
            `Firebase service account file not found at: ${serviceAccountPath}`
          );
        }

        this.logger.log('Using service account file for Firebase initialization');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const serviceAccount = require(serviceAccountPath);
        credential = admin.credential.cert(serviceAccount);
      }
      // Option 2: Utiliser les variables d'environnement (pour la production)
      else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
        this.logger.log('Using environment variables for Firebase initialization');

        // Traitement de la cle privee
        let privateKey = process.env.FIREBASE_PRIVATE_KEY;
        privateKey = privateKey.replace(/\\n/g, '\n');

        if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
          throw new Error('Firebase private key format is invalid');
        }

        credential = admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKey: privateKey,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        });
      }
      else {
        throw new Error(
          'Firebase configuration not found. Please set either:\n' +
          '- FIREBASE_SERVICE_ACCOUNT_PATH (path to JSON file)\n' +
          '- Or all of: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL'
        );
      }

      // Initialiser Firebase
      admin.initializeApp({
        credential: credential,
        projectId: process.env.FIREBASE_PROJECT_ID,
      });

      // Test de validation
      await this.validateConnection();

      this.isInitialized = true;
      this.logger.log('Firebase Admin SDK initialized successfully');

    } catch (error) {
      this.initializationError = error;
      this.logger.error('Firebase initialization failed:', error.message);
    }
  }

  private async validateConnection() {
    try {
      const messaging = admin.messaging();

      // Test avec un token invalide pour verifier que le service repond
      try {
        await messaging.send({
          token: 'fake-token-for-testing',
          notification: { title: 'Test', body: 'Test' }
        });
      } catch (testError) {
        if (testError.code === 'messaging/invalid-registration-token') {
          this.logger.log('FCM service accessible (validation successful)');
        } else {
          throw testError;
        }
      }

    } catch (error) {
      throw new Error(`Firebase validation failed: ${error.message}`);
    }
  }

  getMessaging() {
    if (!this.isInitialized) {
      throw new Error(`Firebase not initialized: ${this.initializationError?.message}`);
    }
    return admin.messaging();
  }

  getAuth() {
    if (!this.isInitialized) {
      throw new Error(`Firebase not initialized: ${this.initializationError?.message}`);
    }
    return admin.auth();
  }

  isReady(): boolean {
    return this.isInitialized;
  }

  getInitializationError(): Error | null {
    return this.initializationError;
  }
}
