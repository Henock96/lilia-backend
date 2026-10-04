import { readFileSync } from 'fs';
import { join } from 'path';

import { escapeLike, FOLD_FROM, FOLD_TO, foldSearchText } from './search-fold';

/**
 * Le texte saisi est replié en TypeScript, les colonnes en SQL
 * (`lilia_search_fold`). Si les deux divergent, « gateau » cesse de retrouver
 * « Gâteaux » sans que rien ne casse ailleurs : ce fichier relit donc la
 * migration et compare les tables, au caractère près.
 */
describe('foldSearchText — miroir de lilia_search_fold', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../../../../prisma/migrations/20261004120000_search_fold/migration.sql',
    ),
    'utf8',
  );

  it('la migration emploie exactement la même table de correspondance', () => {
    expect(sql).toContain(`'${FOLD_FROM}'`);
    expect(sql).toContain(`'${FOLD_TO}'`);
    expect([...FOLD_FROM].length).toBe([...FOLD_TO].length);
  });

  it('la migration remplace œ, æ et l’apostrophe typographique', () => {
    for (const piece of [
      "'œ', 'oe'",
      "'Œ', 'oe'",
      "'æ', 'ae'",
      "'Æ', 'ae'",
      "'’', ''''",
    ]) {
      expect(sql).toContain(piece);
    }
  });

  it.each([
    ['Gâteaux', 'gateaux'],
    ['gâteau', 'gateau'],
    ['Crème brûlée', 'creme brulee'],
    ['Œuf cocotte', 'oeuf cocotte'],
    ['Brochettes d’ailes', "brochettes d'ailes"],
    ['Riz curry au bœuf', 'riz curry au boeuf'],
    ['POULET DG', 'poulet dg'],
  ])('%s → %s', (entrée, attendu) => {
    expect(foldSearchText(entrée)).toBe(attendu);
  });

  it('échappe les jokers de LIKE : « 100% » ne veut pas dire « tout »', () => {
    expect(escapeLike('100%_\\')).toBe('100\\%\\_\\\\');
  });
});
