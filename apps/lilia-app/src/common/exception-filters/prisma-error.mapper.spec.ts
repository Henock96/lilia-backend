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
 * Avant ce mapper, toute violation de contrainte tombait dans le catch-all et
 * devenait un 500 « Erreur interne du serveur ».
 */
describe('mapPrismaError', () => {
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
