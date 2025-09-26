/* eslint-disable prettier/prettier */
// src/auth/firebase-auth.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token manquant!');
    }

    const idToken = authHeader.split(' ')[1];

    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      // Le jeton est valide ! Attacher les informations de l'utilisateur à l'objet de requête.
      request.user = {
        uid: decodedToken.uid,
        email: decodedToken.email,
        emailVerified: decodedToken.email_verified,
        ...decodedToken
      };
      return true;
    } catch (err) {
      console.error('Erreur depuis le Token', err.message);
      throw new UnauthorizedException('Token invalide');
    }
  }
}
