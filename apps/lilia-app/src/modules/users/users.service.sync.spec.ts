import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DecodedIdToken } from 'firebase-admin/auth';

import { UserService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UserCacheService } from '../auth/services/user-cache.service';
import { DeviceInstallationService } from '../devices/device-installation.service';

/**
 * `POST /users/sync` — création du compte à partir du token Firebase.
 *
 * ## Le défaut corrigé
 *
 * Le compte naissait avec `email: email ?? ''` sur une colonne **`@unique`**.
 * Le premier compte sans e-mail passait ; **le deuxième heurtait la contrainte**
 * et recevait un `P2002`, traduit en 409 par `prisma-error.mapper` — un refus
 * d'inscription dont le message ne parle pas d'e-mail, sur un chemin où
 * l'utilisateur n'en a jamais saisi.
 *
 * Le cas n'est pas théorique : l'authentification par téléphone ne fournit
 * aucun e-mail, et « Masquer mon adresse » d'Apple peut n'en fournir aucun au
 * backend selon la configuration du fournisseur.
 *
 * `''` est aussi précisément ce que le schéma documente comme l'erreur passée
 * sur `User.phone` — la chaîne vide **n'échappe pas** à l'unicité PostgreSQL,
 * contrairement à `NULL`, et elle rend tous les comptes concernés « porteurs de
 * la même valeur ».
 */
describe('UserService.syncFromFirebase — identité', () => {
  const makeService = () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(
          async ({ create }: { create: Record<string, unknown> }) => ({
            id: 'u1',
            firebaseUid: create.firebaseUid,
            email: create.email,
            ...create,
            createdAt: new Date(),
          }),
        ),
      },
    };
    const emitter = new EventEmitter2();
    const cache = { invalidate: jest.fn() };
    const devices = { register: jest.fn() };
    const service = new UserService(
      prisma as unknown as PrismaService,
      emitter,
      cache as unknown as UserCacheService,
      devices as unknown as DeviceInstallationService,
    );
    return { service, prisma };
  };

  const token = (over: Partial<DecodedIdToken> = {}): DecodedIdToken =>
    ({ uid: 'fb-1', ...over }) as DecodedIdToken;

  it('refuse explicitement une inscription sans e-mail', async () => {
    // Un refus qui NOMME la cause vaut mieux qu'un 409 de contrainte d'unicité
    // sur une valeur que l'utilisateur n'a jamais saisie.
    const { service, prisma } = makeService();

    await expect(service.syncFromFirebase(token())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('refuse aussi un e-mail vide ou blanc', async () => {
    const { service } = makeService();

    await expect(
      service.syncFromFirebase(token({ email: '   ' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("n'écrit JAMAIS la chaîne vide dans une colonne unique", async () => {
    // La garantie structurelle : quoi qu'il arrive, `''` ne part pas en base.
    const { service, prisma } = makeService();

    await service.syncFromFirebase(token({ email: 'jean@example.com' }));

    const { create } = prisma.user.upsert.mock.calls[0][0];
    expect(create.email).toBe('jean@example.com');
    expect(create.email).not.toBe('');
  });

  it('normalise la casse et les espaces de l’e-mail', async () => {
    // Firebase rend l'adresse telle que saisie. Deux inscriptions avec
    // « Jean@Example.com » et « jean@example.com » désignent la même personne
    // et doivent heurter l'unicité, pas créer deux comptes.
    const { service, prisma } = makeService();

    await service.syncFromFirebase(token({ email: '  Jean@Example.COM ' }));

    expect(prisma.user.upsert.mock.calls[0][0].create.email).toBe(
      'jean@example.com',
    );
  });
});
