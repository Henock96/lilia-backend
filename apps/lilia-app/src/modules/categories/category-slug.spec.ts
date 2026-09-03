import { slugifyCategoryName } from './category-slug';

/**
 * Le slug porte l'unicité par vendeur. Ce qu'il normalise décide donc de ce que
 * la base considère comme « la même section » — c'est une règle métier, pas un
 * détail de présentation.
 */
describe('slugifyCategoryName', () => {
  it('normalise casse, espaces et ponctuation', () => {
    expect(slugifyCategoryName('Boissons')).toBe('boissons');
    expect(slugifyCategoryName('boissons')).toBe('boissons');
    expect(slugifyCategoryName('  BOISSONS  ')).toBe('boissons');
    expect(slugifyCategoryName('Les Grillades !')).toBe('les-grillades');
  });

  it('déplie les accents', () => {
    // Sans cela, « Pâtisseries » et « Patisseries » cohabiteraient chez le même
    // vendeur en se présentant comme deux sections distinctes.
    expect(slugifyCategoryName('Pâtisseries')).toBe('patisseries');
    expect(slugifyCategoryName('Épicerie')).toBe('epicerie');
    expect(slugifyCategoryName('Crème brûlée')).toBe('creme-brulee');
  });

  it('rend le même slug pour les variantes typographiques d’un même nom', () => {
    const variantes = [
      'Boissons',
      'boissons',
      'BOISSONS',
      ' Boissons ',
      'Boissons.',
    ];
    const slugs = new Set(variantes.map(slugifyCategoryName));
    expect(slugs.size).toBe(1);
  });

  it('distingue deux noms réellement différents', () => {
    expect(slugifyCategoryName('Plats')).not.toBe(
      slugifyCategoryName('Plat du jour'),
    );
  });

  it('produit un slug non vide même pour un libellé non latin', () => {
    // Une chaîne vide ne peut pas porter une contrainte d'unicité utile : deux
    // libellés non latins différents deviendraient « la même section ».
    const a = slugifyCategoryName('飲み物');
    const b = slugifyCategoryName('食べ物');
    expect(a).not.toBe('');
    expect(a).not.toBe(b);
  });

  it('est déterministe', () => {
    expect(slugifyCategoryName('Spécialités Maison')).toBe(
      slugifyCategoryName('Spécialités Maison'),
    );
  });
});
