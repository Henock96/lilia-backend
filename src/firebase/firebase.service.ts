/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';

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

      // Verification des variables d'environnement requises
      const requiredEnvVars = [
        'FIREBASE_PROJECT_ID',
        'FIREBASE_PRIVATE_KEY',
        'FIREBASE_CLIENT_EMAIL'
      ];

      const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

      if (missingVars.length > 0) {
        throw new Error(
          `Missing Firebase environment variables: ${missingVars.join(', ')}\n` +
          'Please set these in your .env file or environment'
        );
      }

      // Debug des variables d'environnement (sans exposer les secrets)
      this.logger.log(`Project ID: ${process.env.FIREBASE_PROJECT_ID ? 'SET' : 'NOT SET'}`);
      this.logger.log(`Client Email: ${process.env.FIREBASE_CLIENT_EMAIL ? 'SET' : 'NOT SET'}`);
      this.logger.log(`Private Key: ${process.env.FIREBASE_PRIVATE_KEY ? `SET (${process.env.FIREBASE_PRIVATE_KEY.length} chars)` : 'NOT SET'}`);

      // Traitement de la cle privee
      let privateKey = process.env.FIREBASE_PRIVATE_KEY!;

      // Remplacer les \n litteraux par des vrais retours a la ligne
      privateKey = privateKey.replace(/\\n/g, '\n');

      // Validation du format de la cle
      if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
        throw new Error(
          'Firebase private key format is invalid.\n' +
          'Make sure the key includes "-----BEGIN PRIVATE KEY-----" header'
        );
      }

      // Initialisation avec les variables d'environnement
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID!,
          privateKey: privateKey,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
        }),
        projectId: process.env.FIREBASE_PROJECT_ID,
      });

      // Test de validation
      await this.validateConnection();

      this.isInitialized = true;
      this.logger.log('Firebase Admin SDK initialized successfully');

    } catch (error) {
      this.initializationError = error;
      this.logger.error('Firebase initialization failed:', {
        message: error.message,
        code: error.code,
      });

      // Debug supplementaire en cas d'erreur
      this.logger.error('Debugging info:', {
        nodeEnv: process.env.NODE_ENV,
        hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
        hasClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
        privateKeyLength: process.env.FIREBASE_PRIVATE_KEY?.length || 0,
      });
    }
  }

  private async validateConnection() {
    try {
      // Test FCM pour verifier que le service est accessible
      const messaging = admin.messaging();

      // Test avec un token invalide pour verifier que le service repond
      try {
        await messaging.send({
          token: 'fake-token-for-testing',
          notification: { title: 'Test', body: 'Test' }
        });
      } catch (testError) {
        // On s'attend a une erreur "invalid-registration-token" - c'est normal
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

  // Methode pour obtenir le service Messaging
  getMessaging() {
    if (!this.isInitialized) {
      throw new Error(`Firebase not initialized: ${this.initializationError?.message}`);
    }
    return admin.messaging();
  }

  // Methode pour obtenir le service Auth
  getAuth() {
    if (!this.isInitialized) {
      throw new Error(`Firebase not initialized: ${this.initializationError?.message}`);
    }
    return admin.auth();
  }

  // Methode utilitaire pour verifier le statut
  isReady(): boolean {
    return this.isInitialized;
  }

  getInitializationError(): Error | null {
    return this.initializationError;
  }
}
