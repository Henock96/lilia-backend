import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
//import * as admin from 'firebase-admin';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { HttpExceptionFilter } from './common/exception-filters/http-exception.filter';
import * as admin from 'firebase-admin';
async function bootstrap() {
  if (!admin.apps.length) {
    try {
      console.log('🔄 Initializing Firebase Admin SDK on Render...');
      // Vérification des variables d'environnement
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
      if (!projectId || !clientEmail || !privateKey) {
        throw new Error('Missing Firebase environment variables');
      }

      // Configuration adaptée pour Render
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: projectId,
          privateKey: privateKey.replace(/\\n/g, '\n'), // Important pour Render
          clientEmail: clientEmail,
        }),
        projectId: projectId,
      });

      console.log('✅ Firebase Admin SDK initialized successfully on Render');

      // Test de connexion au démarrage
      await admin.auth().listUsers(1);
      console.log('✅ Firebase connection validated');
    } catch (error) {
      console.error('❌ Firebase initialization failed:', {
        message: error.message,
        code: error.code,
        stack: error.stack,
      });

      // Sur Render, on peut choisir de continuer sans Firebase pour debug
      if (process.env.NODE_ENV === 'production') {
        process.exit(1); // Arrêter en production si Firebase échoue
      }
    }
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useStaticAssets(join(__dirname, '..', 'public'));
  const config = new DocumentBuilder()
    .setTitle('Lilia App API')
    .setDescription('The Lilia App API description')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  // Configuration CORS plus permissive pour autoriser les connexions SSE
  app.enableCors({
    origin: true, // Autorise toutes les origines
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });
  app.useGlobalFilters(new HttpExceptionFilter());
  const port = process.env.PORT || 8080;
  await app.listen(port, '0.0.0.0');
}
bootstrap();
