import { Prisma } from '@prisma/client';

/**
 * Longueur d'un numéro de mobile congolais au format local : `0X XXX XX XX`.
 * Sert à retrouver la partie utile d'un numéro collé au format international.
 */
const LOCAL_MSISDN_LENGTH = 9;

/**
 * En dessous de ce nombre de chiffres, on ne cherche pas de téléphone.
 * « 06 » est le préfixe de presque tous les numéros congolais : le chercher
 * remonterait toute la base et noierait le résultat utile.
 */
const MIN_PHONE_DIGITS = 4;

/**
 * Traduit la recherche libre de l'écran Commandes en clause Prisma.
 *
 * ## Pourquoi elle existe
 *
 * Il n'existait **aucune** recherche de commande — ni dans l'interface, ni dans
 * l'API. Combiné au plafond de pagination, cela rendait inatteignable toute
 * commande qui n'était pas dans les vingt dernières : répondre à « bonjour, ma
 * commande d'hier » imposait d'ouvrir Prisma Studio.
 *
 * ## Ce qu'elle cherche, et pourquoi ces quatre-là
 *
 * Ce sont les quatre entrées qu'un opérateur a réellement sous la main quand un
 * client l'appelle :
 *
 * | Entrée | Champ |
 * |---|---|
 * | le numéro lu à l'écran (`#A1B2C3D4`) | `Order.id` |
 * | le nom du client | `User.nom` |
 * | le nom du commerce | `Restaurant.nom` |
 * | le téléphone | `User.phone` **et** `Order.contactPhone` |
 *
 * Les **deux** téléphones, parce qu'ils ne disent pas la même chose :
 * `user.phone` est celui du compte, `contactPhone` celui saisi au checkout —
 * souvent le seul sur lequel on peut réellement joindre quelqu'un.
 *
 * ⚠️ `mode: 'insensitive'` empêche l'usage d'un index. C'est assumé à l'échelle
 * actuelle : sans insensibilité, l'identifiant tronqué — que l'écran affiche en
 * **majuscules** alors que les cuid sont en minuscules — ne ramènerait jamais
 * rien. Si le volume l'impose un jour, la réponse est un index trigramme
 * (`pg_trgm`), pas le retrait de l'insensibilité.
 *
 * Renvoie `undefined` quand il n'y a rien à chercher : l'appelant n'ajoute
 * alors aucune clause, plutôt qu'un `OR` vide qui ne filtrerait rien tout en
 * coûtant une jointure.
 */
export function buildOrderSearchWhere(
  search?: string,
): Prisma.OrderWhereInput | undefined {
  // Le `#` vient de l'écran : sélectionner « #A1B2C3D4 » l'emporte avec le
  // reste. Le laisser filer ne ramènerait jamais rien, sans que rien
  // n'explique pourquoi.
  const term = search?.trim().replace(/^#/, '').trim();
  if (!term) return undefined;

  const branches: Prisma.OrderWhereInput[] = [
    { id: { contains: term, mode: 'insensitive' } },
    { user: { nom: { contains: term, mode: 'insensitive' } } },
    { restaurant: { nom: { contains: term, mode: 'insensitive' } } },
  ];

  const phone = toPhoneNeedle(term);
  if (phone) {
    branches.push({ user: { phone: { contains: phone } } });
    branches.push({ contactPhone: { contains: phone } });
  }

  return { OR: branches };
}

/**
 * Partie recherchable d'un numéro saisi à la main.
 *
 * Les numéros sont stockés au format local (`066123456`). Un opérateur qui
 * colle « +242 06 612 34 56 » depuis son carnet ne trouverait rien si on
 * cherchait la chaîne entière : on retient donc les neuf derniers chiffres,
 * ce qui absorbe l'indicatif pays comme la ponctuation.
 */
function toPhoneNeedle(term: string): string | null {
  const digits = term.replace(/\D/g, '');
  if (digits.length < MIN_PHONE_DIGITS) return null;

  return digits.length >= LOCAL_MSISDN_LENGTH
    ? digits.slice(-LOCAL_MSISDN_LENGTH)
    : digits;
}
