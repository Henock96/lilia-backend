/* eslint-disable prettier/prettier */
// src/firebase/firebase.module.ts (exemple d'un module dédié)
import { Module, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as fs from 'fs'
// Importez votre fichier de clé de compte de service
// Idéalement, utilisez des variables d'environnement pour la production (process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
// Pour le développement, vous pouvez le require directement si le fichier est local
const serviceAccount = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT, 'utf-8'))
@Module({
})
export class FirebaseModule implements OnModuleInit {
  onModuleInit() {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        // Vous pouvez aussi ajouter d'autres configurations si nécessaire, comme databaseURL si vous utilisez RTDB
      });
      console.log('Firebase Admin SDK initialized.');
    }
  }
}
