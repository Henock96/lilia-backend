/**
 * Repliement du texte de recherche — miroir exact de la fonction SQL
 * `lilia_search_fold` (migration 20261004120000_search_fold).
 *
 * La saisie du client est repliée ici, les colonnes le sont en SQL : les deux
 * côtés doivent produire la même chaîne, sinon « gateau » ne retrouve pas
 * « Gâteaux ». `search-fold.spec.ts` relit la migration et compare les tables.
 */
export const FOLD_FROM =
  'àâäáãåçéèêëíìîïñóòôöõúùûüýÿÀÂÄÁÃÅÇÉÈÊËÍÌÎÏÑÓÒÔÖÕÚÙÛÜÝ';
export const FOLD_TO = 'aaaaaaceeeeiiiinooooouuuuyyaaaaaaceeeeiiiinooooouuuuy';

const TABLE = new Map([...FOLD_FROM].map((c, i) => [c, FOLD_TO[i]]));

export function foldSearchText(text: string): string {
  const replaced = text
    .replace(/œ/g, 'oe')
    .replace(/Œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/Æ/g, 'ae')
    .replace(/’/g, "'");
  let out = '';
  for (const c of replaced) out += TABLE.get(c) ?? c;
  return out.toLowerCase();
}

/** Échappe les jokers de `LIKE` (`\`, `%`, `_`) — à employer avec `ESCAPE '\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Seuil de `word_similarity` (pg_trgm) pour la recherche approchée. Mesuré en
 * production le 04/10/2026 : les fautes réelles sortent entre 0,57 et 0,78
 * (« poulle » → poulet, « piza » → pizza, « brochete » → brochettes), le bruit
 * plafonne à 0,29.
 */
export const FUZZY_THRESHOLD = 0.5;

/** En deçà, une saisie est trop courte pour qu'un trigramme ait du sens. */
export const FUZZY_MIN_LENGTH = 4;
