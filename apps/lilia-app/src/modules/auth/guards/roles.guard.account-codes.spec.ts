import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

/**
 * Jeton Firebase valide, compte absent ou révoqué : le refus porte un code
 * machine. Sans lui, les apps affichaient « Compte non synchronisé » en boucle
 * au lieu de revenir à l'écran de connexion (bug du 24/09/2026, comptes
 * supprimés pendant que les téléphones gardaient leur session).
 */
function context() {
  const request = { firebaseUser: { uid: 'fb-1' } } as Record<string, unknown>;
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

function guard(user: unknown) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
  const cache = { getByFirebaseUid: jest.fn().mockResolvedValue(user) };
  return new RolesGuard(reflector as unknown as Reflector, cache as never);
}

async function refusal(user: unknown) {
  try {
    await guard(user).canActivate(context());
  } catch (e) {
    return e as ForbiddenException;
  }
  throw new Error('aucun refus');
}

describe('RolesGuard — codes de refus de compte', () => {
  it('aucun compte en base : ACCOUNT_NOT_SYNCED, message inchangé', async () => {
    const e = await refusal(null);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getResponse()).toEqual({
      message:
        'Compte non synchronisé. Appelez POST /users/sync avant cette action.',
      code: 'ACCOUNT_NOT_SYNCED',
    });
  });

  it('compte supprimé : ACCOUNT_REVOKED', async () => {
    const e = await refusal({
      id: 'u1',
      role: 'CLIENT',
      statusUser: 'DELETED',
    });
    expect(e.getResponse()).toMatchObject({ code: 'ACCOUNT_REVOKED' });
  });

  it('compte bloqué : ACCOUNT_REVOKED', async () => {
    const e = await refusal({
      id: 'u1',
      role: 'CLIENT',
      statusUser: 'BLOCKED',
    });
    expect(e.getResponse()).toMatchObject({ code: 'ACCOUNT_REVOKED' });
  });
});
