import { buildOrderSearchWhere } from './order-search';

/**
 * Recherche de commande.
 *
 * Il n'en existait aucune — ni côté interface, ni côté API. Combiné au plafond
 * de pagination, cela rendait **inatteignable** toute commande qui n'était pas
 * dans les vingt dernières : répondre à « bonjour, ma commande d'hier » passait
 * par Prisma Studio (audit du 09/09/2026, blocker n°2).
 *
 * Ces tests décrivent les quatre entrées qu'un opérateur a réellement sous la
 * main quand un client l'appelle : le numéro affiché sur l'écran, le nom, le
 * téléphone, le nom du commerce.
 */
describe('buildOrderSearchWhere', () => {
  it('ne filtre rien sur une recherche vide', () => {
    expect(buildOrderSearchWhere(undefined)).toBeUndefined();
    expect(buildOrderSearchWhere('')).toBeUndefined();
    expect(buildOrderSearchWhere('   ')).toBeUndefined();
  });

  it('cherche dans l’identifiant, le nom du client et celui du vendeur', () => {
    const where = buildOrderSearchWhere('Marie');

    expect(where).toEqual({
      OR: [
        { id: { contains: 'Marie', mode: 'insensitive' } },
        { user: { nom: { contains: 'Marie', mode: 'insensitive' } } },
        { restaurant: { nom: { contains: 'Marie', mode: 'insensitive' } } },
      ],
    });
  });

  it('accepte l’identifiant tronqué tel qu’il est affiché', () => {
    // L'écran montre `#A1B2C3D4` — les huit derniers caractères, en
    // majuscules. C'est ce que l'opérateur lit au téléphone et recopie.
    const where = buildOrderSearchWhere('A1B2C3D4');
    const branches = (where as { OR: unknown[] }).OR;

    expect(branches).toContainEqual({
      id: { contains: 'A1B2C3D4', mode: 'insensitive' },
    });
  });

  it('ignore le dièse recopié depuis l’écran', () => {
    // Sélectionner le numéro affiché emporte le `#`. Le laisser filer ne
    // ramènerait jamais rien, sans que rien n'explique pourquoi.
    const where = buildOrderSearchWhere('#A1B2C3D4');
    const branches = (where as { OR: unknown[] }).OR;

    expect(branches).toContainEqual({
      id: { contains: 'A1B2C3D4', mode: 'insensitive' },
    });
  });

  it('cherche aussi dans les deux téléphones dès qu’il y a des chiffres', () => {
    // `user.phone` est le compte, `contactPhone` le numéro saisi au checkout —
    // souvent celui qu'on peut réellement appeler.
    const where = buildOrderSearchWhere('066123456');
    const branches = (where as { OR: unknown[] }).OR;

    expect(branches).toContainEqual({
      user: { phone: { contains: '066123456' } },
    });
    expect(branches).toContainEqual({
      contactPhone: { contains: '066123456' },
    });
  });

  it('retient les neuf derniers chiffres d’un numéro international', () => {
    // Les numéros sont stockés au format local (`066123456`). Un opérateur qui
    // colle « +242 06 612 34 56 » depuis son carnet ne trouverait rien si on
    // cherchait la chaîne entière.
    const where = buildOrderSearchWhere('+242 06 612 34 56');
    const branches = (where as { OR: unknown[] }).OR;

    expect(branches).toContainEqual({
      user: { phone: { contains: '066123456' } },
    });
  });

  it('ignore la ponctuation d’un numéro saisi à la main', () => {
    const where = buildOrderSearchWhere('06-612-34-56');
    const branches = (where as { OR: unknown[] }).OR;

    expect(branches).toContainEqual({
      user: { phone: { contains: '066123456' } },
    });
  });

  it('ne cherche pas de téléphone sur trop peu de chiffres', () => {
    // « 06 » est le préfixe de presque tous les numéros congolais : le chercher
    // remonterait toute la base et noierait le résultat utile.
    const where = buildOrderSearchWhere('06');
    const branches = (where as { OR: unknown[] }).OR;

    expect(branches).toHaveLength(3);
    expect(JSON.stringify(branches)).not.toContain('contactPhone');
  });

  it('ne cherche pas de téléphone dans un terme sans chiffre', () => {
    const branches = (buildOrderSearchWhere('Marie') as { OR: unknown[] }).OR;

    expect(branches).toHaveLength(3);
  });

  it('n’est pas sensible aux espaces autour du terme', () => {
    expect(buildOrderSearchWhere('  Marie  ')).toEqual(
      buildOrderSearchWhere('Marie'),
    );
  });
});
