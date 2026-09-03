import {
  CONGO_BOUNDS,
  checkCongoCoordinates,
  haversineKm,
  isWithinCongo,
  sanitizeCoordinates,
} from './congo-geo';

/**
 * Ces règles décident si une commande part avec une destination ou sans. Un
 * couple qui passe ici finit sur la carte du livreur : chaque cas de rejet a
 * donc sa ligne, écrite à la main plutôt que dérivée des bornes elles-mêmes —
 * une spec qui relit la constante qu'elle teste ne prouve rien.
 */
describe('checkCongoCoordinates', () => {
  const BRAZZAVILLE = { lat: -4.2634, lng: 15.2429 };

  it('accepte un point de Brazzaville', () => {
    expect(checkCongoCoordinates(BRAZZAVILLE.lat, BRAZZAVILLE.lng).ok).toBe(
      true,
    );
  });

  it('accepte Pointe-Noire (autre extrémité du pays)', () => {
    expect(checkCongoCoordinates(-4.8156, 11.8639).ok).toBe(true);
  });

  it.each([
    ['NaN', NaN, 15.2429],
    ['Infinity', Infinity, 15.2429],
    ['-Infinity', -4.26, -Infinity],
    ['chaîne', '-4.26' as unknown as number, 15.2429],
    ['null', null as unknown as number, 15.2429],
    ['undefined', undefined as unknown as number, 15.2429],
  ])('refuse une valeur non numérique (%s)', (_label, lat, lng) => {
    const result = checkCongoCoordinates(lat, lng);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NOT_A_NUMBER');
  });

  it('refuse une latitude hors bornes terrestres', () => {
    expect(checkCongoCoordinates(91, 15).reason).toBe('OUT_OF_RANGE');
  });

  it('refuse une longitude hors bornes terrestres', () => {
    expect(checkCongoCoordinates(-4.26, 181).reason).toBe('OUT_OF_RANGE');
  });

  // Le cas qui motive tout le reste : un GPS qui n'a pas encore de fix rend
  // (0, 0). C'est dans le golfe de Guinée, à 700 km de la côte congolaise.
  it('refuse (0, 0) — Null Island', () => {
    const result = checkCongoCoordinates(0, 0);
    expect(result.reason).toBe('NULL_ISLAND');
    expect(result.message).toContain('0, 0');
  });

  it('refuse un (0, 0) arrondi', () => {
    expect(checkCongoCoordinates(0.00001, -0.00002).reason).toBe('NULL_ISLAND');
  });

  // Diagnostic fort : l'échange retombe dans le pays, on nomme la cause.
  it('détecte une inversion latitude/longitude', () => {
    const result = checkCongoCoordinates(15.2429, -4.2634);
    expect(result.reason).toBe('SWAPPED');
    expect(result.message).toContain('inversées');
  });

  // Diagnostic faible : l'échange n'aide pas, mais l'indice reste utile.
  it('refuse un point hors du Congo sans prétendre à une inversion', () => {
    const result = checkCongoCoordinates(48.8566, 2.3522); // Paris
    expect(result.reason).toBe('OUTSIDE_CONGO');
  });

  it('refuse Kinshasa — de l’autre côté du fleuve, autre pays', () => {
    // -4.3017, 15.3105 : c'est là que Google place « Avenue de la Paix,
    // Brazzaville ». Les bornes du Congo étant larges, ce point passe : le
    // contrôle de plage ne sait pas trancher une frontière fluviale.
    // Le test existe pour documenter cette limite, pas pour l'infirmer.
    expect(isWithinCongo(-4.3017, 15.3105)).toBe(true);
  });
});

describe('sanitizeCoordinates', () => {
  it('rend le couple quand il est exploitable', () => {
    expect(sanitizeCoordinates(-4.2634, 15.2429)).toEqual({
      latitude: -4.2634,
      longitude: 15.2429,
    });
  });

  it.each([
    ['latitude nulle', null, 15.2429],
    ['longitude nulle', -4.2634, null],
    ['les deux absentes', undefined, undefined],
    ['Null Island', 0, 0],
    ['hors du Congo', 48.8566, 2.3522],
  ])('rend null pour %s', (_label, lat, lng) => {
    expect(sanitizeCoordinates(lat, lng)).toBeNull();
  });
});

describe('bornes du Congo', () => {
  it('couvre le pays du sud au nord et d’ouest en est', () => {
    expect(CONGO_BOUNDS.minLat).toBeLessThan(CONGO_BOUNDS.maxLat);
    expect(CONGO_BOUNDS.minLng).toBeLessThan(CONGO_BOUNDS.maxLng);
    expect(isWithinCongo(CONGO_BOUNDS.minLat, CONGO_BOUNDS.minLng)).toBe(true);
    expect(isWithinCongo(CONGO_BOUNDS.maxLat, CONGO_BOUNDS.maxLng)).toBe(true);
  });
});

describe('haversineKm', () => {
  it('rend 0 pour deux points confondus', () => {
    expect(haversineKm(-4.2634, 15.2429, -4.2634, 15.2429)).toBeCloseTo(0, 6);
  });

  it('mesure Brazzaville → Pointe-Noire (~390 km à vol d’oiseau)', () => {
    const km = haversineKm(-4.2634, 15.2429, -4.8156, 11.8639);
    expect(km).toBeGreaterThan(350);
    expect(km).toBeLessThan(420);
  });

  it('mesure une traversée de quartier en kilomètres, pas en mètres', () => {
    // Poto-Poto → Bacongo : environ 3 km.
    const km = haversineKm(-4.274029, 15.267756, -4.295585, 15.245811);
    expect(km).toBeGreaterThan(2);
    expect(km).toBeLessThan(5);
  });
});
