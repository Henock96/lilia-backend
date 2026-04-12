/* eslint-disable prettier/prettier */
// auth/types/authenticated-request.interface.ts
import { Request } from 'express';
import { DecodedIdToken } from 'firebase-admin/auth';
import { User } from '@prisma/client';

/**
 * Extension typée de Request Express.
 * Peuplée par FirebaseAuthGuard puis RolesGuard dans l'ordre.
 */
export interface AuthenticatedRequest extends Request {
  /** Token Firebase décodé — disponible après FirebaseAuthGuard */
  firebaseUser: DecodedIdToken;

  /** Enregistrement Prisma complet — disponible après RolesGuard */
  user: User;
}
