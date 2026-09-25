import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import type { ResolvedSelection } from './modifier-selection';
import { isPrismaError } from './prisma-errors';

/** Tentatives d'insertion avant d'abandonner une course perdue en boucle. */
const MAX_ADD_ATTEMPTS = 3;

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Ajoute `quantite` à la ligne `(panier, variante, sélection d'options)`, ou
 * la crée. Partagé par `POST /cart/add` et le recommander : une seule façon
 * d'écrire une ligne individuelle.
 *
 * ## Pourquoi pas `findFirst` puis `create`
 *
 * C'était la forme historique (et, au recommander, `quantite + n` lu puis
 * réécrit) : deux appareils du même compte ajoutant le même plat au même
 * instant lisaient tous deux « aucune ligne » et créaient tous deux — l'index
 * unique partiel refusait le second en P2002, que personne ne rattrapait (500
 * au client, ajout perdu).
 *
 * 1. `updateMany … increment` d'abord : l'addition est faite par PostgreSQL
 *    sur la valeur courante, deux ajouts se composent au lieu de s'écraser ;
 * 2. aucune ligne ? on la crée, options comprises (création imbriquée : une
 *    seule transaction implicite) ;
 * 3. un concurrent l'a créée entre 1 et 2 → P2002 sur l'index
 *    `(cartId, variantId, optionsSignature) WHERE menuId IS NULL` → on
 *    recommence en 1, qui la trouve cette fois.
 *
 * Prouvé sur PostgreSQL réel (`cart-modifiers.int-spec.ts`) : N ajouts
 * concurrents de la même sélection = 1 ligne, quantité N.
 *
 * La signature fait partie de l'identité : « Poulet + Alloco » et « Poulet +
 * Frites » sont deux lignes ; « Poulet + Alloco » ajouté deux fois, une seule.
 */
export async function mergeCartLine(
  db: Db,
  args: {
    cartId: string;
    productId: string;
    variantId: string;
    selection: ResolvedSelection;
    quantite: number;
  },
): Promise<void> {
  const { cartId, productId, variantId, selection, quantite } = args;
  for (let attempt = 1; ; attempt++) {
    const merged = await db.cartItem.updateMany({
      where: {
        cartId,
        variantId,
        menuId: null,
        optionsSignature: selection.signature,
      },
      data: { quantite: { increment: quantite } },
    });
    if (merged.count > 0) return;
    try {
      await db.cartItem.create({
        data: {
          cartId,
          productId,
          variantId,
          quantite,
          optionsSignature: selection.signature,
          options: {
            create: selection.lines.map((option) => ({
              optionId: option.optionId,
              quantity: option.quantity,
            })),
          },
        },
      });
      return;
    } catch (err) {
      if (isPrismaError(err, 'P2002') && attempt < MAX_ADD_ATTEMPTS) continue;
      if (isPrismaError(err, 'P2003')) {
        // L'option a été réellement supprimée entre la résolution et l'écriture.
        throw new ConflictException({
          message:
            "Une option choisie vient d'être retirée de la carte. Rechargez l'article puis recommencez.",
          code: 'MODIFIER_UNAVAILABLE',
        });
      }
      throw err;
    }
  }
}
