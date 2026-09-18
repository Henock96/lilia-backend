import { computeDeliverySplit, MAX_SHARE_PERCENT } from './money.util';

/**
 * Partage des frais de livraison entre le livreur et Lilia Food.
 *
 * ## L'invariant qui commande tout
 *
 * ```
 * driverPayXaf + liliaShareXaf === baseXaf     — exactement, toujours
 * ```
 *
 * Il est obtenu **par construction**, pas par vérification : seule la part du
 * livreur est calculée, celle de Lilia est le **résidu**. Deux pourcentages
 * appliqués séparément à la même base ne se recomposent pas — `round(333×35%)
 * + round(333×65%)` vaut 334, pas 333. Un franc apparu de nulle part sur
 * chaque course, c'est une comptabilité fausse.
 *
 * ## Pourquoi on stocke la part du LIVREUR
 *
 * C'est le nombre du contrat (« tu touches 35 % de la course »), donc celui
 * qu'un humain vérifiera. Le nombre qu'on vérifie doit être celui qui est
 * exact, pas le dérivé.
 *
 * ⚠️ Ne jamais réintroduire `percentToBasisPoints` ici : il écrête à
 * `MAX_COMMISSION_PERCENT` (50), ce qui transformerait silencieusement la part
 * d'un livreur indépendant à 65 % en 50 %. Deux plafonds pour deux notions.
 */
describe('computeDeliverySplit — le partage de la course', () => {
  describe('les trois cas du modèle métier', () => {
    it('livreur Lilia à 35 % : 1 000 → livreur 350, Lilia 650', () => {
      expect(
        computeDeliverySplit({ baseXaf: 1000, driverSharePercent: 35 }),
      ).toEqual({
        baseXaf: 1000,
        driverSharePercent: 35,
        driverPayXaf: 350,
        liliaShareXaf: 650,
      });
    });

    it('indépendant à 65 % : 1 000 → livreur 650, Lilia 350', () => {
      const split = computeDeliverySplit({
        baseXaf: 1000,
        driverSharePercent: 65,
      });
      expect(split.driverPayXaf).toBe(650);
      expect(split.liliaShareXaf).toBe(350);
    });

    it('indépendant à 70 % : 1 000 → livreur 700, Lilia 300', () => {
      const split = computeDeliverySplit({
        baseXaf: 1000,
        driverSharePercent: 70,
      });
      expect(split.driverPayXaf).toBe(700);
      expect(split.liliaShareXaf).toBe(300);
    });

    it('indépendant à 60 % : 1 000 → livreur 600, Lilia 400', () => {
      const split = computeDeliverySplit({
        baseXaf: 1000,
        driverSharePercent: 60,
      });
      expect(split.driverPayXaf).toBe(600);
      expect(split.liliaShareXaf).toBe(400);
    });

    it('n’inverse pas le sens : à 35 %, le livreur touche MOINS que Lilia', () => {
      // Le cadrage le demande explicitement. Un test qui ne compare que des
      // nombres laisserait passer une inversion des deux champs.
      const split = computeDeliverySplit({
        baseXaf: 1000,
        driverSharePercent: 35,
      });
      expect(split.driverPayXaf).toBeLessThan(split.liliaShareXaf);
    });
  });

  describe('l’invariant de somme', () => {
    const bases = [0, 1, 7, 100, 333, 999, 1000, 1234, 99_999, 1_000_000];
    const shares = [0, 1, 30, 33.33, 35, 50, 60, 65, 66.67, 70, 99, 100];

    it('livreur + Lilia === base, sur toutes les combinaisons', () => {
      for (const baseXaf of bases) {
        for (const driverSharePercent of shares) {
          const s = computeDeliverySplit({ baseXaf, driverSharePercent });
          expect(s.driverPayXaf + s.liliaShareXaf).toBe(baseXaf);
        }
      }
    });

    it('aucune part n’est négative ni supérieure à la base', () => {
      for (const baseXaf of bases) {
        for (const driverSharePercent of shares) {
          const s = computeDeliverySplit({ baseXaf, driverSharePercent });
          expect(s.driverPayXaf).toBeGreaterThanOrEqual(0);
          expect(s.driverPayXaf).toBeLessThanOrEqual(baseXaf);
          expect(s.liliaShareXaf).toBeGreaterThanOrEqual(0);
          expect(s.liliaShareXaf).toBeLessThanOrEqual(baseXaf);
        }
      }
    });

    it('les deux parts sont des entiers — le XAF n’a pas de sous-unité', () => {
      const s = computeDeliverySplit({ baseXaf: 333, driverSharePercent: 35 });
      expect(Number.isInteger(s.driverPayXaf)).toBe(true);
      expect(Number.isInteger(s.liliaShareXaf)).toBe(true);
    });

    it('arrondit la part du livreur, et Lilia absorbe le reste', () => {
      // 333 × 35 % = 116,55 → 117 au franc le plus proche. Lilia prend 216,
      // et la somme reste 333 : c'est le résidu qui absorbe l'arrondi.
      const s = computeDeliverySplit({ baseXaf: 333, driverSharePercent: 35 });
      expect(s.driverPayXaf).toBe(117);
      expect(s.liliaShareXaf).toBe(216);
    });
  });

  describe('les bornes du partage', () => {
    it('0 % : le livreur ne touche rien, Lilia garde tout', () => {
      const s = computeDeliverySplit({ baseXaf: 1000, driverSharePercent: 0 });
      expect(s).toMatchObject({ driverPayXaf: 0, liliaShareXaf: 1000 });
    });

    it('100 % : le livreur prend tout, Lilia ne garde rien', () => {
      const s = computeDeliverySplit({
        baseXaf: 1000,
        driverSharePercent: 100,
      });
      expect(s).toMatchObject({ driverPayXaf: 1000, liliaShareXaf: 0 });
    });

    it('base à 0 : les deux parts valent 0, et ce n’est pas une erreur', () => {
      // Le cas existe : un vendeur peut poser `fixedDeliveryFee = 0`. On rend
      // 0/0 plutôt que de lever — c'est une information, pas une panne.
      const s = computeDeliverySplit({ baseXaf: 0, driverSharePercent: 35 });
      expect(s).toMatchObject({ driverPayXaf: 0, liliaShareXaf: 0 });
    });

    it('le plafond de partage est 100, pas celui de la commission', () => {
      // `MAX_COMMISSION_PERCENT` vaut 50 : l'y soumettre ramènerait
      // silencieusement un indépendant à 65 % vers 50 %.
      expect(MAX_SHARE_PERCENT).toBe(100);
      const s = computeDeliverySplit({ baseXaf: 1000, driverSharePercent: 65 });
      expect(s.driverSharePercent).toBe(65);
    });
  });

  describe('ce qui doit être refusé plutôt que corrigé en silence', () => {
    it.each([
      -1,
      -0.01,
      100.01,
      101,
      1000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])('refuse un taux de %p', (driverSharePercent) => {
      expect(() =>
        computeDeliverySplit({ baseXaf: 1000, driverSharePercent }),
      ).toThrow();
    });

    it('refuse une base négative', () => {
      expect(() =>
        computeDeliverySplit({ baseXaf: -1, driverSharePercent: 35 }),
      ).toThrow();
    });

    it('refuse une base non finie', () => {
      expect(() =>
        computeDeliverySplit({ baseXaf: Number.NaN, driverSharePercent: 35 }),
      ).toThrow();
    });
  });
});
