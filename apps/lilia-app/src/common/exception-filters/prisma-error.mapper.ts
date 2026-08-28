import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Traduction des erreurs Prisma en réponses HTTP métier.
 *
 * Sans ça, toute violation de contrainte remontait au catch-all et devenait un
 * **500 « Erreur interne du serveur »**. Cas concret et atteignable par un
 * utilisateur normal : `Review` porte `@@unique([userId, restaurantId])` — un
 * client qui commande une seconde fois chez le même vendeur et laisse un avis
 * déclenchait un P2002 non attrapé, là où le message attendu est « Vous avez
 * déjà noté ce vendeur ».
 *
 * Un seul filtre global (`HttpExceptionFilter`) consomme ce mapper : pas de
 * dépendance à l'ordre d'enregistrement des filtres Nest.
 */
export interface MappedPrismaError {
  status: number;
  message: string;
}

/** Le message d'erreur Prisma expose le nom des colonnes — jamais au client. */
function fieldsOf(err: Prisma.PrismaClientKnownRequestError): string[] {
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === 'string') return [target];
  return [];
}

/**
 * Messages métier pour les contraintes d'unicité connues. Le fallback reste
 * générique : on ne veut pas fuiter la structure de la base au client.
 */
const UNIQUE_MESSAGES: Record<string, string> = {
  'userId,restaurantId': 'Vous avez déjà laissé un avis pour ce vendeur.',
  'userId,productId': 'Vous avez déjà laissé un avis pour ce produit.',
  orderId: 'Cette commande a déjà été traitée.',
  email: 'Cette adresse e-mail est déjà utilisée.',
  phone: 'Ce numéro de téléphone est déjà utilisé.',
  firebaseUid: 'Ce compte existe déjà.',
  referralCode: 'Ce code de parrainage est déjà attribué.',
  code: 'Ce code existe déjà.',
  token: 'Ce token est déjà enregistré.',
};

export function mapPrismaError(exception: unknown): MappedPrismaError | null {
  if (exception instanceof Prisma.PrismaClientValidationError) {
    // Requête malformée côté serveur, mais déclenchée par une entrée client
    // hors bornes (type inattendu). 400 plutôt qu'un 500 opaque.
    return {
      status: HttpStatus.BAD_REQUEST,
      message: 'Requête invalide.',
    };
  }

  if (!(exception instanceof Prisma.PrismaClientKnownRequestError)) {
    return null;
  }

  switch (exception.code) {
    // Violation de contrainte d'unicité
    case 'P2002': {
      const fields = fieldsOf(exception);
      const known = UNIQUE_MESSAGES[fields.join(',')];
      return {
        status: HttpStatus.CONFLICT,
        message: known ?? 'Cette valeur existe déjà.',
      };
    }

    // Enregistrement requis introuvable (update/delete sur un id inexistant)
    case 'P2025':
      return {
        status: HttpStatus.NOT_FOUND,
        message: 'Ressource introuvable.',
      };

    // Violation de clé étrangère. Deux cas réels depuis l'activation des FK
    // (migration `enable_foreign_keys`) :
    //   - à l'écriture : on référence un parent qui n'existe pas ;
    //   - à la suppression : un enfant en `RESTRICT` empêche d'effacer le
    //     parent (ex. supprimer un produit qui figure dans une commande).
    // Le second est le plus fréquent et mérite un message actionnable.
    case 'P2003':
      return {
        status: HttpStatus.CONFLICT,
        message:
          'Opération impossible : cette ressource est liée à d’autres données ' +
          '(commande, panier ou historique). Désactivez-la plutôt que de la supprimer.',
      };

    // Valeur trop longue pour la colonne
    case 'P2000':
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Une des valeurs fournies est trop longue.',
      };

    // Suppression bloquée par une relation requise
    case 'P2014':
      return {
        status: HttpStatus.CONFLICT,
        message:
          'Suppression impossible : cette ressource est encore liée à d’autres données.',
      };

    default:
      return null;
  }
}
