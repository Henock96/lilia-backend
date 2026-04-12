/* eslint-disable prettier/prettier */
// src/auth/firebase-auth.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FirebaseService } from '../../firebase/firebase.service';
import { AuthenticatedRequest } from '../types/authenticated-request.interface';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';


@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(FirebaseAuthGuard.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
     // Permet de marquer une route @Public() pour court-circuiter le guard
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);

    try {
      /**
       * checkRevoked: false sur les routes normales (performance).
       * Pour les routes très sensibles (changement mot de passe, suppression compte),
       * utiliser un guard séparé avec checkRevoked: true.
       * Firebase recommande de ne pas activer checkRevoked sur chaque requête
       * car ça fait un appel réseau supplémentaire vers Firebase.
       */
      const decodedToken = await this.firebase.getAuth().verifyIdToken(token, false);
      request.firebaseUser = decodedToken; // On attache le token décodé à la requête pour les guards suivants
      return true;
    } catch (err) {

      // Messages d'erreur distincts pour aider le client mobile à réagir
      if (err.code === 'auth/id-token-expired') {
        throw new UnauthorizedException('TOKEN_EXPIRED'); // client doit refresh
      }
      if (err.code === 'auth/id-token-revoked') {
        throw new UnauthorizedException('TOKEN_REVOKED'); // client doit se reconnecter
      }

      throw new UnauthorizedException('Token invalide');
    }
  }

  private extractToken(request: AuthenticatedRequest): string {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token manquant!');
    }

    return authHeader.split(' ')[1];
  } 
}
