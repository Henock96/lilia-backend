import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';

/**
 * Corps de `POST /payments` (fix H1 — audit du 28/08/2026).
 *
 * La route était typée par une **interface TypeScript** (`CreatePaymentRequest`),
 * qui n'existe pas au runtime : le `design:paramtype` émis valait `Object`, le
 * `ValidationPipe` global sautait la validation (`toValidate()` → false) et
 * `whitelist: true` ne filtrait rien. Sur un endpoint d'argent, `phoneNumber`
 * arrivait brut et était persisté tel quel, et `payerMessage` était relayé sans
 * borne à l'API MTN.
 *
 * `amount` a été **supprimé** : le montant vient toujours de `order.total` côté
 * serveur (`payment.service.ts`). Le champ n'était jamais lu — le garder dans
 * le contrat était un piège pour la prochaine évolution (L5).
 */
export class CreatePaymentDto {
  @IsString()
  @IsNotEmpty({ message: 'La commande à payer est requise.' })
  @MaxLength(64)
  orderId: string;

  @IsString()
  @IsNotEmpty({ message: 'Le numéro de téléphone est requis.' })
  @Matches(/^(\+?242)?0?[456]\d{7}$/, {
    message: 'Numéro de téléphone congolais invalide (ex : 06 123 45 67)',
  })
  phoneNumber: string;

  @IsOptional()
  @IsString()
  @MaxLength(140, {
    message: 'Le message de paiement ne peut pas dépasser 140 caractères.',
  })
  payerMessage?: string;

  /**
   * Opérateur visé pour CETTE tentative. Facultatif : à défaut, on reprend
   * `Order.paymentMethod`, choisi au checkout.
   *
   * Le champ existe parce qu'une seconde tentative vise souvent un autre
   * opérateur — le client n'a plus de solde MTN et paie en Airtel. Sans lui, il
   * faudrait repasser la commande.
   */
  @IsOptional()
  @IsEnum(PaymentMethod, {
    message: 'Opérateur invalide (MTN_MOMO ou AIRTEL_MONEY).',
  })
  method?: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;
}
