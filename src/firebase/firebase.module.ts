/* eslint-disable prettier/prettier */
// src/firebase/firebase.module.ts (exemple d'un module dédié)
import { Module, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as fs from 'fs'
import * as path from 'path';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { RolesGuard } from './roles.guard';
import { Reflector } from '@nestjs/core';
// Importez votre fichier de clé de compte de service
// Idéalement, utilisez des variables d'environnement pour la production (process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
// Pour le développement, vous pouvez le require directement si le fichier est local
//const serviceAccount = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT, 'utf-8'))

 // Cette variable contiendra l'objet de configuration final, peu importe la méthode
  let serviceAccount: admin.ServiceAccount;
    
  // 1. On cherche d'abord la variable d'environnement pour la production (Fly.io)
   const encodedServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  
   if (encodedServiceAccount) {
      // ON EST EN PRODUCTION
      console.log('Initialisation de Firebase via variable d\'environnement (production)...');
      //const decodedJson = Buffer.from(encodedServiceAccount, 'base64').toString('utf-8');
      serviceAccount = JSON.parse(encodedServiceAccount);                        
    } else {                                                           
      // ON EST EN LOCAL                                               
      console.log('Initialisation de Firebase via fichier local (développement)...');
      // On utilise la variable d'environnement qui pointe vers le chemin du fichier
      const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
                                                                      
      if (!serviceAccountPath) {                                       
       throw new Error('La variable d\'environnement FIREBASE_SERVICE_ACCOUNT_PATH est manquante pour le développement local.');
         }
  
     // On s'assure que le chemin est correct depuis la racine du projet
      const absolutePath = path.join(process.cwd(), serviceAccountPath);
   
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Le fichier de service Firebase n'a pas été trouvé au chemin :
      ${absolutePath}`);
     }
  
      const fileContents = fs.readFileSync(absolutePath, 'utf-8');
      serviceAccount = JSON.parse(fileContents);
   }
@Module({
  providers: [
    FirebaseAuthGuard,
    RolesGuard,
    Reflector,
  ],
  exports: [FirebaseAuthGuard, RolesGuard],
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
