import { HttpStatus } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { DecodedIdToken } from 'firebase-admin/auth';

import { UserService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UserCacheService } from '../auth/services/user-cache.service';
import { DeviceInstallationService } from '../devices/device-installation.service';
import { mapPrismaError } from '../../common/exception-filters/prisma-error.mapper';

/**
 * `POST /users/sync` pour un compte **Sign in with Apple**.
 *
 * Le backend n'a pas de login Apple à lui : l'app iOS passe par Firebase, et
 * le serveur ne voit qu'un ID token Firebase dont
 * `firebase.sign_in_provider = 'apple.com'`. Ces tests fixent que ce token
 * suit **exactement** le chemin de Google et de l'e-mail — aucune branche
 * Apple dans le service, et aucune n'est nécessaire :
 *
 * - l'adresse relais `…@privaterelay.appleid.com` est une adresse valide,
 *   conservée telle quelle ;
 * - Apple ne fournit le nom qu'à la première autorisation : son absence
 *   retombe sur le repli existant ;
 * - un UID Firebase = un compte, quel que soit le nombre de synchronisations ;
 * - un second UID portant la même adresse heurte `email @unique` → 409.
 */
describe('UserService.syncFromFirebase — Sign in with Apple', () => {
  const RELAIS = 'x7k2p9qz4m@privaterelay.appleid.com';

  const makeService = (existant: Record<string, unknown> | null = null) => {
    const prisma = {
      user: {
        // Recherche par `firebaseUid` : le compte existe-t-il déjà ?
        // Recherche par `referralCode` : génération d'un code libre, ou
        // validation d'un parrain — aucun ici.
        findUnique: jest.fn(
          async ({ where }: { where: Record<string, unknown> }) =>
            'firebaseUid' in where ? existant : null,
        ),
        upsert: jest.fn(
          async ({
            create,
            update,
          }: {
            where: Record<string, unknown>;
            create: Record<string, unknown>;
            update: Record<string, unknown>;
          }) => ({
            id: 'u-apple',
            ...(existant ?? create),
            ...(existant ? update : {}),
            createdAt: new Date(),
          }),
        ),
      },
    };
    const emitter = new EventEmitter2();
    const emitted: string[] = [];
    emitter.onAny((event) => emitted.push(String(event)));
    const cache = { invalidate: jest.fn() };
    const devices = { register: jest.fn() };
    const service = new UserService(
      prisma as unknown as PrismaService,
      emitter,
      cache as unknown as UserCacheService,
      devices as unknown as DeviceInstallationService,
    );
    return { service, prisma, emitted };
  };

  /** Ce que Firebase Admin décode d'un ID token issu de Sign in with Apple. */
  const appleToken = (over: Partial<DecodedIdToken> = {}): DecodedIdToken =>
    ({
      uid: 'fb-apple-1',
      email: RELAIS,
      email_verified: true,
      firebase: {
        sign_in_provider: 'apple.com',
        identities: { 'apple.com': ['001234.abcdef.0987'], email: [RELAIS] },
      },
      ...over,
    }) as DecodedIdToken;

  it(
    'A — première connexion avec nom et adresse relais : CLIENT créé, ' +
      'adresse conservée',
    async () => {
      const { service, prisma, emitted } = makeService();

      const { isNewUser } = await service.syncFromFirebase(
        appleToken({ name: 'Jean Dupont' }),
      );

      expect(isNewUser).toBe(true);
      const { where, create } = prisma.user.upsert.mock.calls[0][0];
      expect(where).toEqual({ firebaseUid: 'fb-apple-1' });
      expect(create).toMatchObject({
        firebaseUid: 'fb-apple-1',
        email: RELAIS,
        nom: 'Jean Dupont',
        role: 'CLIENT',
      });
      expect(create.referralCode).toEqual(expect.any(String));
      expect(emitted).toContain('user.created');
    },
  );

  it(
    'A bis — l’adresse relais n’est ni refusée ni réécrite, même en ' +
      'majuscules',
    async () => {
      const { service, prisma } = makeService();

      await service.syncFromFirebase(
        appleToken({ email: 'X7K2P9QZ4M@PrivateRelay.AppleID.com' }),
      );

      expect(prisma.user.upsert.mock.calls[0][0].create.email).toBe(RELAIS);
    },
  );

  it(
    'B — sans nom (non partagé, ou connexion ultérieure) : repli existant ' +
      'sur le préfixe de l’adresse',
    async () => {
      const { service, prisma } = makeService();

      await service.syncFromFirebase(appleToken());

      const { create } = prisma.user.upsert.mock.calls[0][0];
      expect(create.nom).toBe('x7k2p9qz4m');
      expect(create.role).toBe('CLIENT');
    },
  );

  it(
    'C — deuxième synchronisation du même UID : mise à jour, pas de ' +
      'doublon, rôle intact, nom conservé en l’absence de `name`',
    async () => {
      const { service, prisma, emitted } = makeService({
        id: 'u-apple',
        firebaseUid: 'fb-apple-1',
        email: RELAIS,
        nom: 'Jean Dupont',
        role: 'CLIENT',
      });

      const { isNewUser, user } = await service.syncFromFirebase(
        appleToken(),
        undefined,
        'PARRAIN8',
      );

      expect(isNewUser).toBe(false);
      const { where, update } = prisma.user.upsert.mock.calls[0][0];
      expect(where).toEqual({ firebaseUid: 'fb-apple-1' });
      expect(update).not.toHaveProperty('role');
      expect(update).not.toHaveProperty('nom');
      expect(update).not.toHaveProperty('referredByCode');
      expect(update.lastLogin).toBeInstanceOf(Date);
      expect(user.nom).toBe('Jean Dupont');
      expect(emitted).not.toContain('user.created');
    },
  );

  it('C bis — le parrainage n’est lu qu’à la création', async () => {
    const { service, prisma } = makeService();

    await service.syncFromFirebase(appleToken(), undefined, 'INCONNU1');

    // Parrain introuvable → aucun rattachement, mais le compte est créé.
    expect(
      prisma.user.upsert.mock.calls[0][0].create.referredByCode,
    ).toBeNull();
  });

  it(
    'D — un autre UID Firebase avec la même adresse heurte l’unicité : ' +
      'l’erreur remonte et devient un 409 explicite',
    async () => {
      const { service, prisma } = makeService();
      prisma.user.upsert.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['email'] },
        }),
      );

      const erreur = await service
        .syncFromFirebase(
          appleToken({ uid: 'fb-autre', email: 'jean@example.com' }),
        )
        .catch((e: unknown) => e);

      // Le service ne rattrape pas : il ne crée ni ne fusionne rien en silence.
      expect(erreur).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(mapPrismaError(erreur)).toEqual({
        status: HttpStatus.CONFLICT,
        message: 'Cette adresse e-mail est déjà utilisée.',
      });
    },
  );

  it(
    'l’identité ne vient que du token : le fournisseur n’ouvre aucun ' +
      'privilège',
    async () => {
      const { service, prisma } = makeService();

      await service.syncFromFirebase(
        appleToken({ role: 'ADMIN', admin: true } as Partial<DecodedIdToken>),
      );

      expect(prisma.user.upsert.mock.calls[0][0].create.role).toBe('CLIENT');
    },
  );
});
