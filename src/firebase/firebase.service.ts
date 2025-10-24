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
      this.logger.log('🔄 Initializing Firebase on Render...');
      
      // Debug des variables d'environnement (sans exposer les secrets)
      this.logger.log(`Project ID: ${process.env.FIREBASE_PROJECT_ID ? 'SET' : 'NOT SET'}`);
      this.logger.log(`Client Email: ${process.env.FIREBASE_CLIENT_EMAIL ? 'SET' : 'NOT SET'}`);
      this.logger.log(`Private Key: ${process.env.FIREBASE_PRIVATE_KEY ? `SET (${process.env.FIREBASE_PRIVATE_KEY.length} chars)` : 'NOT SET'}`);

      const requiredEnvVars = [
        'FIREBASE_PROJECT_ID',
        'FIREBASE_PRIVATE_KEY', 
        'FIREBASE_CLIENT_EMAIL'
      ];

      const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
      
      if (missingVars.length > 0) {
        throw new Error(`Missing Firebase environment variables: ${missingVars.join(', ')}`);
      }

      // Traitement spécial de la clé privée pour Render
      let privateKey = process.env.FIREBASE_PRIVATE_KEY!;
      
      // Si la clé n'a pas les marqueurs BEGIN/END, quelque chose ne va pas
      if (!privateKey.includes('BEGIN PRIVATE KEY')) {
        this.logger.warn('Private key seems malformed, attempting to fix...');
        // Tentative de correction si la clé est encodée différemment
        privateKey = privateKey.replace(/\\n/g, '\n');
      }

      // Validation finale du format
      if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
        throw new Error('Firebase private key format is invalid');
      }

      // Configuration pour Render avec variables d'environnement individuelles
      const firebaseConfig = {
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID!,
          privateKey: privateKey,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
        }),
        projectId: process.env.FIREBASE_PROJECT_ID,
      };

      admin.initializeApp(firebaseConfig);

      // Test de validation
      await this.validateConnection();
      
      this.isInitialized = true;
      this.logger.log('✅ Firebase Admin SDK initialized successfully on Render');

    } catch (error) {
      this.initializationError = error;
      this.logger.error('❌ Firebase initialization failed:', {
        message: error.message,
        code: error.code,
      });
      
      // En production sur Render, on veut savoir pourquoi ça échoue
      if (process.env.NODE_ENV === 'production') {
        this.logger.error('🔍 Debugging info:', {
          nodeEnv: process.env.NODE_ENV,
          hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
          hasClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
          privateKeyLength: process.env.FIREBASE_PRIVATE_KEY?.length || 0,
          renderService: process.env.RENDER_SERVICE_NAME,
        });
      }
    }
  }

  private async validateConnection() {
    try {
      
      // Test FCM (plus pertinent pour votre use case)
      const messaging = admin.messaging();
      
      // Test avec un token invalide pour vérifier que le service répond
      try {
        await messaging.send({
          token: 'fake-token-for-testing',
          notification: { title: 'Test', body: 'Test' }
        });
      } catch (testError) {
        // On s'attend à une erreur "invalid-registration-token"
        if (testError.code === 'messaging/invalid-registration-token') {
          this.logger.log('✅ FCM service accessible (expected invalid token error)');
        } else {
          throw testError;
        }
      }
      
    } catch (error) {
      throw new Error(`Firebase validation failed: ${error.message}`);
    }
  }

  // Méthodes avec gestion d'erreur pour éviter les crashes
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

  // Méthode utilitaire pour vérifier le statut
  isReady(): boolean {
    return this.isInitialized;
  }

  getInitializationError(): Error | null {
    return this.initializationError;
  }
}