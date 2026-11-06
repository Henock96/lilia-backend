import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { mapPrismaError } from './prisma-error.mapper';

const knownError = (code: string, target?: string[] | string) =>
  new Prisma.PrismaClientKnownRequestError('boom', {
    code,
    clientVersion: 'test',
    meta: target ? { target } : undefined,
  });

/**
 * Forme réelle d'un P2002 sous `@prisma/adapter-pg`, relevée sur PostgreSQL :
 * pas de `meta.target`, et des colonnes copiées du texte de l'erreur, donc
 * entre guillemets dès qu'elles portent une majuscule.
 */
const adapterError = (fields: string[]) =>
  new Prisma.PrismaClientKnownRequestError('boom', {
    code: 'P2002',
    clientVersion: 'test',
    meta: {
      modelName: 'User',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { fields },
        },
      },
    },
  });

/**
 * Avant ce mapper, toute violation de contrainte tombait dans le catch-all et
 * devenait un 500 « Erreur interne du serveur ».
 */
describe('mapPrismaError', () => {
  describe('P2002 sous @prisma/adapter-pg', () => {
    it('reconnaît une colonne en minuscules', () => {
      expect(mapPrismaError(adapterError(['email']))).toEqual({
        status: HttpStatus.CONFLICT,
        message: 'Cette adresse e-mail est déjà utilisée.',
      });
    });

    it('reconnaît une colonne citée entre guillemets', () => {
      expect(mapPrismaError(adapterError(['"firebaseUid"']))?.message).toBe(
        'Ce compte existe déjà.',
      );
    });

    it('reconnaît une contrainte composée', () => {
      expect(
        mapPrismaError(adapterError(['"userId"', '"restaurantId"']))?.message,
      ).toBe('Vous avez déjà enregistré ce vendeur.');
    });

    it('garde le message générique sur une contrainte inconnue, sans fuiter la colonne', () => {
      const mapped = mapPrismaError(adapterError(['"colonneInterne"']));

      expect(mapped?.status).toBe(HttpStatus.CONFLICT);
      expect(mapped?.message).toBe('Cette valeur existe déjà.');
    });
  });

  it('traduit P2002 sur (userId, restaurantId) en 409 avec message métier (favoris)', () => {
    const mapped = mapPrismaError(
      knownError('P2002', ['userId', 'restaurantId']),
    );

    expect(mapped).toEqual({
      status: HttpStatus.CONFLICT,
      message: 'Vous avez déjà enregistré ce vendeur.',
    });
  });

  it('traduit un P2002 inconnu en 409 générique, sans fuiter les colonnes', () => {
    const mapped = mapPrismaError(knownError('P2002', ['colonne_interne']));

    expect(mapped?.status).toBe(HttpStatus.CONFLICT);
    expect(mapped?.message).toBe('Cette valeur existe déjà.');
    expect(mapped?.message).not.toContain('colonne_interne');
  });

  it('traduit P2025 en 404', () => {
    expect(mapPrismaError(knownError('P2025'))?.status).toBe(
      HttpStatus.NOT_FOUND,
    );
  });

  it('traduit P2003 (clé étrangère) en 409 avec un message actionnable', () => {
    const mapped = mapPrismaError(knownError('P2003'));

    // Cas le plus fréquent depuis l'activation des FK : une suppression bloquée
    // par un enfant en RESTRICT (produit référencé par une commande).
    expect(mapped?.status).toBe(HttpStatus.CONFLICT);
    expect(mapped?.message).toContain('Désactivez-la');
  });

  it('traduit P2014 (relation requise) en 409', () => {
    expect(mapPrismaError(knownError('P2014'))?.status).toBe(
      HttpStatus.CONFLICT,
    );
  });

  it('traduit une PrismaClientValidationError en 400', () => {
    const err = new Prisma.PrismaClientValidationError('invalide', {
      clientVersion: 'test',
    });
    expect(mapPrismaError(err)?.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('laisse passer un code Prisma non mappé (→ 500 assumé)', () => {
    expect(mapPrismaError(knownError('P9999'))).toBeNull();
  });

  it('ignore les erreurs non-Prisma', () => {
    expect(mapPrismaError(new Error('boom'))).toBeNull();
  });
});
