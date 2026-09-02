/**
 * Contrôles géographiques partagés — vendeurs, adresses clients, commandes.
 *
 * Ces règles vivaient uniquement dans `VendorReadinessService`, appliquées aux
 * seuls vendeurs. Le raisonnement qui les justifiait — « sans GPS juste, l'ETA
 * et le trajet du livreur sont faux » — vaut évidemment aussi pour la
 * destination de livraison, qui n'en bénéficiait pas. On les sort donc du
 * module `vendors` pour que les deux côtés de la course soient tenus au même
 * standard.
 */

/**
 * Bornes géographiques de la République du Congo, marge incluse.
 *
 * Le contrôle de plage attrape l'inversion latitude/longitude et le
 * copier-coller malheureux, qui sont les deux erreurs réelles ; il ne prétend
 * pas vérifier que le point est la bonne devanture.
 */
export const CONGO_BOUNDS = {
  minLat: -5.5,
  maxLat: 3.8,
  minLng: 10.5,
  maxLng: 19.0,
} as const;

/** Centre de Brazzaville — repère de diagnostic, jamais une destination. */
export const BRAZZAVILLE_CENTER = { lat: -4.2634, lng: 15.2429 } as const;

export type GeoRejection =
  | 'NOT_A_NUMBER'
  | 'OUT_OF_RANGE'
  | 'NULL_ISLAND'
  | 'SWAPPED'
  | 'OUTSIDE_CONGO';

export interface GeoCheck {
  ok: boolean;
  reason?: GeoRejection;
  /** Message en français, affichable tel quel. */
  message?: string;
}

const MESSAGES: Record<GeoRejection, string> = {
  NOT_A_NUMBER: 'Coordonnées invalides (valeur non numérique).',
  OUT_OF_RANGE:
    'Coordonnées hors bornes terrestres (latitude ±90, longitude ±180).',
  NULL_ISLAND:
    'Coordonnées (0, 0) refusées : ce point est dans le golfe de Guinée, ' +
    "c'est la signature d'un GPS non initialisé.",
  SWAPPED:
    'Latitude et longitude semblent inversées : au Congo la latitude est ' +
    'proche de -4 et la longitude proche de 15.',
  // L'indice d'inversion est répété ici alors que `SWAPPED` existe : ce
  // dernier n'est rendu que lorsque l'échange retombe *effectivement* dans le
  // pays. Pour un point qui reste hors bornes dans les deux sens — Paris, par
  // exemple — c'est malgré tout la cause la plus fréquente, et la taire
  // priverait l'utilisateur de la seule piste utile.
  OUTSIDE_CONGO:
    'Coordonnées hors du Congo — vérifiez que latitude et longitude ne sont ' +
    'pas inversées.',
};

/** `true` si la valeur est un nombre exploitable (ni NaN, ni ±Infinity). */
function isRealNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Valide un couple de coordonnées destiné à une adresse ou une commande.
 *
 * L'ordre des contrôles n'est pas indifférent : `(0, 0)` est techniquement
 * dans les bornes terrestres, et une inversion lat/lng est techniquement hors
 * du Congo. Tester du plus spécifique au plus général permet de rendre le
 * message qui dit à l'utilisateur **quoi corriger**, pas seulement que c'est
 * refusé.
 */
export function checkCongoCoordinates(
  latitude: unknown,
  longitude: unknown,
): GeoCheck {
  if (!isRealNumber(latitude) || !isRealNumber(longitude)) {
    return fail('NOT_A_NUMBER');
  }

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return fail('OUT_OF_RANGE');
  }

  // Null Island. Le seuil est volontairement large : un GPS qui n'a pas
  // encore de fix rend exactement 0, mais un arrondi à 4 décimales sur une
  // valeur nulle passerait sous un test d'égalité stricte.
  if (Math.abs(latitude) < 0.0001 && Math.abs(longitude) < 0.0001) {
    return fail('NULL_ISLAND');
  }

  if (isWithinCongo(latitude, longitude)) return { ok: true };

  // Le couple échangé retombe-t-il dans le pays ? Si oui, on nomme la cause
  // au lieu de rendre un « hors du Congo » qui n'aide personne.
  if (isWithinCongo(longitude, latitude)) return fail('SWAPPED');

  return fail('OUTSIDE_CONGO');
}

export function isWithinCongo(latitude: number, longitude: number): boolean {
  return (
    latitude >= CONGO_BOUNDS.minLat &&
    latitude <= CONGO_BOUNDS.maxLat &&
    longitude >= CONGO_BOUNDS.minLng &&
    longitude <= CONGO_BOUNDS.maxLng
  );
}

/**
 * Variante tolérante pour les données déjà en base : rend le couple s'il est
 * exploitable, `null` sinon. Utilisée par le résolveur de destination, qui ne
 * doit pas faire échouer une commande à cause d'une vieille ligne douteuse —
 * il se rabat sur le repli suivant.
 */
export function sanitizeCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): { latitude: number; longitude: number } | null {
  if (latitude === null || latitude === undefined) return null;
  if (longitude === null || longitude === undefined) return null;
  return checkCongoCoordinates(latitude, longitude).ok
    ? { latitude, longitude }
    : null;
}

function fail(reason: GeoRejection): GeoCheck {
  return { ok: false, reason, message: MESSAGES[reason] };
}

/** Distance à vol d'oiseau, en kilomètres. */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
