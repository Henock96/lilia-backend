import { BadRequestException } from '@nestjs/common';
import { DeliveryPriceMode } from '@prisma/client';

import {
  assertNotLastZoneOfZoneBasedVendor,
  assertZoneCoverage,
  isZoneCoverageMissing,
} from './zone-coverage';

const { FIXED, ZONE_BASED } = DeliveryPriceMode;

/**
 * L'invariant « ZONE_BASED ⇒ au moins une zone ».
 *
 * Ces cas sont écrits **à la main**, pas dérivés de l'implémentation. C'est la
 * leçon de la spec « exhaustive » de la machine à états d'août : elle tirait
 * ses attentes de `ORDER_TRANSITION_MATRIX` elle-même, vérifiait donc que le
 * code sait lire sa table, jamais que la table est juste — et a laissé passer
 * B-1. Une règle métier doit avoir sa ligne écrite en clair.
 */
describe('Couverture de zone — l’invariant de la tarification par zone', () => {
  describe('isZoneCoverageMissing', () => {
    it('signale un vendeur ZONE_BASED sans aucune zone', () => {
      expect(isZoneCoverageMissing(ZONE_BASED, 0)).toBe(true);
    });

    it('accepte un vendeur ZONE_BASED avec au moins une zone', () => {
      expect(isZoneCoverageMissing(ZONE_BASED, 1)).toBe(false);
    });

    it('ignore le nombre de zones en mode FIXED', () => {
      expect(isZoneCoverageMissing(FIXED, 0)).toBe(false);
    });

    it('ignore un vendeur qui ne livre pas — il n’a pas de zones à définir', () => {
      // Retrait au comptoir uniquement : son mode de tarification ne sert à
      // rien et ne doit bloquer aucune écriture.
      expect(isZoneCoverageMissing(ZONE_BASED, 0, false)).toBe(false);
    });
  });

  describe('assertZoneCoverage', () => {
    it('refuse la bascule en ZONE_BASED sans zone', () => {
      expect(() => assertZoneCoverage(ZONE_BASED, 0)).toThrow(
        BadRequestException,
      );
    });

    it('dit pourquoi, et ce qui se passerait sinon', () => {
      // Le message doit nommer la conséquence — « tarif de repli » — sinon
      // l'administrateur croit à une validation tatillonne et cherche à la
      // contourner.
      expect(() => assertZoneCoverage(ZONE_BASED, 0)).toThrow(/repli/i);
    });

    it('laisse passer une configuration valide', () => {
      expect(() => assertZoneCoverage(ZONE_BASED, 3)).not.toThrow();
      expect(() => assertZoneCoverage(FIXED, 0)).not.toThrow();
    });
  });

  describe('assertNotLastZoneOfZoneBasedVendor', () => {
    it('refuse de supprimer la dernière zone d’un vendeur ZONE_BASED', () => {
      // `0` = ce qu'il resterait APRÈS la suppression.
      expect(() => assertNotLastZoneOfZoneBasedVendor(ZONE_BASED, 0)).toThrow(
        BadRequestException,
      );
    });

    it('autorise la suppression tant qu’il reste une zone', () => {
      expect(() =>
        assertNotLastZoneOfZoneBasedVendor(ZONE_BASED, 1),
      ).not.toThrow();
    });

    it('autorise la suppression de toutes les zones d’un vendeur en tarif fixe', () => {
      // Ses zones ne servent à rien : elles peuvent disparaître sans rien
      // changer à ce que paie le client.
      expect(() => assertNotLastZoneOfZoneBasedVendor(FIXED, 0)).not.toThrow();
    });

    it('propose une sortie plutôt qu’un simple refus', () => {
      expect(() => assertNotLastZoneOfZoneBasedVendor(ZONE_BASED, 0)).toThrow(
        /tarif fixe/i,
      );
    });
  });
});
