-- ═══════════════════════════════════════════════════════════════════════════
-- Recherche insensible aux accents — `lilia_search_fold`
--
-- Constaté en production le 03/10/2026 : « gâteau » trouvait 7 plats,
-- « gateau » n'en trouvait aucun. Sur un clavier de téléphone, la plupart des
-- clients tapent sans accents.
--
-- `translate` plutôt que l'extension `unaccent`, pour la même raison que
-- `lilia_category_slug` (20260903120000) : une migration ne dépend pas d'une
-- extension qui peut manquer sur l'instance cible. Table de correspondance du
-- français, plus œ/æ (deux lettres, donc `replace`) et l'apostrophe typographique
-- (« d’ailes » doit répondre à « d'ailes »).
--
-- ⚠️ Miroir exact de `foldSearchText` (products/search-fold.ts) : le texte saisi
-- est replié côté Node, les colonnes côté SQL. `search-fold.spec.ts` relit ce
-- fichier et échoue si les deux tables divergent.
--
-- IMMUTABLE : utilisable dans un index d'expression si le catalogue grossit
-- (195 produits en production au 04/10/2026 : un parcours séquentiel suffit).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION lilia_search_fold(txt text) RETURNS text AS $$
  SELECT lower(translate(
    replace(replace(replace(replace(replace(coalesce(txt, ''),
      'œ', 'oe'), 'Œ', 'oe'), 'æ', 'ae'), 'Æ', 'ae'), '’', ''''),
    'àâäáãåçéèêëíìîïñóòôöõúùûüýÿÀÂÄÁÃÅÇÉÈÊËÍÌÎÏÑÓÒÔÖÕÚÙÛÜÝ',
    'aaaaaaceeeeiiiinooooouuuuyyaaaaaaceeeeiiiinooooouuuuy'));
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- `word_similarity` (fautes de frappe) vient de pg_trgm, déjà installée par
-- 20260520000000_add_perf_indexes. Rappelée ici pour une base où elle aurait
-- été retirée : sans elle, la recherche approchée lèverait une erreur.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
