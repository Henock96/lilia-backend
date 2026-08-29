import { SetMetadata } from '@nestjs/common';

export const ALLOW_UNSYNCED_KEY = 'allowUnsynced';

/**
 * Autorise une route à s'exécuter alors que le compte Firebase n'a pas encore
 * de ligne `User` en base (fix M6 — audit du 28/08/2026).
 *
 * Par défaut, `RolesGuard` exige désormais que le user Prisma existe sur toute
 * route authentifiée : sans `@Roles()`, il faisait `return true` même quand
 * `request.user` était absent, et `@CurrentUser()` arrivait `undefined` dans le
 * controller — `PUT /users/me` appelait alors `updateUser(undefined.id)` et
 * renvoyait un 500 opaque, tout comme `DELETE /users/me`.
 *
 * Deux routes ont une raison légitime de tourner sans user synchronisé :
 *  - `POST /users/sync`, qui le crée précisément ;
 *  - `GET /users/me`, qui doit pouvoir répondre « pas encore de profil ».
 */
export const AllowUnsynced = () => SetMetadata(ALLOW_UNSYNCED_KEY, true);
