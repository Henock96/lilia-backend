import { Prisma } from '@prisma/client';

/**
 * L'erreur est-elle une erreur Prisma connue portant ce code ?
 *
 * P2002 (unicité) et P2003 (clé étrangère) servent d'arbitres de course au
 * panier : ce sont des issues attendues, pas des pannes.
 */
export function isPrismaError(err: unknown, code: 'P2002' | 'P2003'): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === code
  );
}
