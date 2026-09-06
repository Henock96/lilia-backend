import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { LOW_STOCK_THRESHOLD, stockStatusWhere } from './stock-status';
import { ProductFilterQueryDto } from './dto/product-query.dto';

/**
 * Filtre « où en est mon stock ? ».
 *
 * Aucune surface ne permettait de retrouver les produits en rupture : l'admin
 * web les colorait en rouge, mais dans une liste paginée de tout le catalogue.
 * Un vendeur de cinquante références devait parcourir trois pages pour trouver
 * les deux qu'il doit réassortir.
 */
describe('Filtre de stock — vue gestionnaire', () => {
  describe('stockStatusWhere', () => {
    it('« out » ne prend que les ruptures franches', () => {
      expect(stockStatusWhere('out')).toEqual({ stockRestant: 0 });
    });

    it('« low » exclut les ruptures — ce n’est pas le même geste', () => {
      // Une rupture appelle un réassort, un stock faible une surveillance.
      // Les mélanger noierait les urgences dans les alertes.
      expect(stockStatusWhere('low')).toEqual({
        stockRestant: { gt: 0, lte: LOW_STOCK_THRESHOLD },
      });
    });

    it('« unlimited » vise `null`, jamais zéro', () => {
      // `null` = pas de gestion de stock, `0` = épuisé. Les confondre ferait
      // apparaître les produits épuisés parmi les « illimités ».
      expect(stockStatusWhere('unlimited')).toEqual({ stockRestant: null });
    });

    it('« tracked » vise tout ce qui a un compteur', () => {
      expect(stockStatusWhere('tracked')).toEqual({
        stockRestant: { not: null },
      });
    });

    it('reprend le seuil déjà utilisé par l’interface', () => {
      // L'admin web colore en ambre à `stockRestant <= 3` depuis toujours. Un
      // second seuil ferait diverger la liste filtrée et la couleur de la
      // carte — deux réponses à la même question.
      expect(LOW_STOCK_THRESHOLD).toBe(3);
    });
  });

  describe('ProductFilterQueryDto', () => {
    const errorsFor = (query: Record<string, string>) =>
      validateSync(plainToInstance(ProductFilterQueryDto, query));

    it.each(['out', 'low', 'unlimited', 'tracked'])(
      'accepte stockStatus=%s',
      (status) => {
        expect(errorsFor({ stockStatus: status })).toHaveLength(0);
      },
    );

    it('refuse une valeur inconnue', () => {
      // Un filtre silencieusement ignoré est pire qu'un filtre absent : il fait
      // croire que le catalogue est sain.
      expect(errorsFor({ stockStatus: 'epuise' }).length).toBeGreaterThan(0);
    });

    it('reste facultatif', () => {
      expect(errorsFor({})).toHaveLength(0);
    });
  });
});
