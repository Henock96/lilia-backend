import { DiscountType, Prisma, PromoFunding } from '@prisma/client';
import { randomInt } from 'node:crypto';

/**
 * Avoir nominatif (R-06.6) : un code promo à usage unique, réservé à un
 * client, financé par la plateforme.
 *
 * Deux gestes en émettent : la clôture d'une réclamation (F3-06) et la
 * clôture d'une livraison par l'ADMIN (arbitrage de livraison, 15/11/2026).
 * La forme du code vit ici pour que les deux restent identiques.
 */

/** Alphabet sans caractères ambigus (0/O, 1/I/L) : le code se dicte au téléphone. */
const VOUCHER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function voucherCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += VOUCHER_ALPHABET[randomInt(VOUCHER_ALPHABET.length)];
  }
  return `AVOIR-${s}`;
}

export interface NominativeVoucherInput {
  userId: string;
  amountXaf: number;
  expiresAt: Date;
  description: string;
}

/**
 * Écrit l'avoir dans la transaction de l'appelant : il naît avec le geste qui
 * le justifie, ou pas du tout.
 *
 * Une collision de code lève `P2002` et avorte la transaction PostgreSQL : pas
 * de nouvel essai ici (31⁸ codes possibles), l'appelant traduit en 409.
 */
export function createNominativeVoucher(
  tx: Prisma.TransactionClient,
  input: NominativeVoucherInput,
): Promise<{ id: string; code: string }> {
  return tx.promoCode.create({
    data: {
      code: voucherCode(),
      description: input.description,
      discountType: DiscountType.FIXED,
      discountValue: input.amountXaf,
      minOrderAmount: 0,
      maxUsageTotal: 1,
      maxUsagePerUser: 1,
      assignedUserId: input.userId,
      fundingSource: PromoFunding.PLATFORM,
      expiresAt: input.expiresAt,
    },
    select: { id: true, code: true },
  });
}
