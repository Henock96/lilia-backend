// Les décorateurs de class-validator lisent les métadonnées de type émises
// par TypeScript : sans ce polyfill, `plainToInstance` échoue hors contexte
// Nest (qui l'importe lui-même au bootstrap).
import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';

import { CreateProductDto } from './create-product.dto';
import { UpdateProductDto } from './update-product.dto';
import { CreateDeliveryZoneDto } from '../../quartiers/dto/delivery-zone.dto';

/**
 * Les montants sont des entiers de francs CFA (audit post-correction, B-6).
 *
 * Le XAF n'a pas de sous-unité : 1 250,5 FCFA ne veut rien dire. Les DTO
 * validaient pourtant avec `@IsNumber()`, qui accepte n'importe quel décimal.
 * Un prix à `1250.5` entrait donc en base — où les colonnes sont encore des
 * `Float` — et se propageait dans les sous-totaux, les 8 % de frais de service
 * et les points de fidélité, jusqu'à des écarts d'un franc entre le total
 * affiché au client et celui facturé.
 *
 * `@IsInt()` ferme la porte à l'entrée, ce qui est la seule barrière posable
 * sans toucher au schéma. Elle reste utile même après la migration
 * `Float → Int` : PostgreSQL arrondirait silencieusement là où l'API refuse et
 * explique.
 */
describe('intégrité des montants en XAF', () => {
  /**
   * Messages d'erreur pour un chemin de propriété, y compris imbriqué.
   *
   * Le chemin compte : le prix d'un produit est porté par `prixOriginal`, et
   * `prix` n'existe que sur les **variantes** (`variants.0.prix`). C'est par
   * cette voie qu'était passé l'exploit H3 — une variante à prix négatif
   * faisait chuter le sous-total du panier — donc c'est celle qu'il faut
   * vérifier, pas seulement le niveau racine.
   */
  function errorsAt(dto: object, path: string): string[] {
    const walk = (errors: ValidationError[], prefix: string): string[] =>
      errors.flatMap((e) => {
        const here = prefix ? `${prefix}.${e.property}` : e.property;
        return [
          ...(here === path ? Object.values(e.constraints ?? {}) : []),
          ...walk(e.children ?? [], here),
        ];
      });

    return walk(validateSync(dto, { whitelist: true }), '');
  }

  describe('CreateProductDto', () => {
    const base = {
      nom: 'Poulet braisé',
      description: 'Avec bananes plantains',
      categoryId: 'c-1',
    };

    it('rejette un prix à virgule', () => {
      const dto = plainToInstance(CreateProductDto, {
        ...base,
        prixOriginal: 1250.5,
      });

      const messages = errorsAt(dto, 'prixOriginal');
      expect(messages).not.toHaveLength(0);
      // Le message doit dire *pourquoi* : un vendeur qui saisit 1250,5 ne
      // devine pas « integer » tout seul.
      expect(messages.join(' ')).toContain('francs CFA');
    });

    it('accepte un prix entier', () => {
      const dto = plainToInstance(CreateProductDto, {
        ...base,
        prixOriginal: 1250,
      });

      expect(errorsAt(dto, 'prixOriginal')).toHaveLength(0);
    });

    it('rejette une variante à prix décimal', () => {
      // Le chemin réellement exploitable : le prix effectivement facturé est
      // celui de la variante choisie.
      const dto = plainToInstance(CreateProductDto, {
        ...base,
        prixOriginal: 1000,
        variants: [{ label: '30cl', prix: 500.25 }],
      });

      expect(errorsAt(dto, 'variants.0.prix')).not.toHaveLength(0);
    });

    it('rejette toujours un prix négatif', () => {
      // Contre-épreuve : `@IsInt` ne doit pas avoir remplacé les bornes
      // existantes (fix H3), seulement s'y ajouter.
      const dto = plainToInstance(CreateProductDto, {
        ...base,
        prixOriginal: -1,
      });

      expect(errorsAt(dto, 'prixOriginal').join(' ')).toContain('négatif');
    });
  });

  describe('UpdateProductDto', () => {
    it('rejette un prix à virgule sur la mise à jour aussi', () => {
      // Le chemin de mise à jour est le plus emprunté — les prix bougent plus
      // souvent qu'ils ne sont créés. L'oublier laisserait la porte ouverte.
      const dto = plainToInstance(UpdateProductDto, { prixOriginal: 999.99 });

      expect(errorsAt(dto, 'prixOriginal')).not.toHaveLength(0);
    });

    it('rejette une variante à prix décimal en mise à jour', () => {
      const dto = plainToInstance(UpdateProductDto, {
        variants: [{ label: '50cl', prix: 750.5 }],
      });

      expect(errorsAt(dto, 'variants.0.prix')).not.toHaveLength(0);
    });

    it('laisse passer une mise à jour sans prix', () => {
      const dto = plainToInstance(UpdateProductDto, { nom: 'Nouveau nom' });

      expect(errorsAt(dto, 'prixOriginal')).toHaveLength(0);
    });
  });

  describe('CreateDeliveryZoneDto', () => {
    it('rejette un tarif de livraison à virgule', () => {
      const dto = plainToInstance(CreateDeliveryZoneDto, {
        nom: 'Bacongo',
        fee: 500.5,
        quartierIds: ['q-1'],
      });

      expect(errorsAt(dto, 'fee')).not.toHaveLength(0);
    });
  });
});
