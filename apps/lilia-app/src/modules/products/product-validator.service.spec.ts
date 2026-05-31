/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { ProductType, VendorType } from '@prisma/client';
import { ProductValidatorService } from './product-validator.service';

/**
 * Tests purement logiques — pas de Prisma, pas de DI.
 * Couvre LIL-114 : matrice vendorType ↔ productType, rejet ALCOHOL (pivot),
 * fenêtre availableFrom/availableUntil.
 */
describe('ProductValidatorService', () => {
  const validator = new ProductValidatorService();

  describe('assertProductTypeAllowed', () => {
    it('RESTAURANT accepte FOOD et BEVERAGE', () => {
      expect(() =>
        validator.assertProductTypeAllowed(VendorType.RESTAURANT, ProductType.FOOD),
      ).not.toThrow();
      expect(() =>
        validator.assertProductTypeAllowed(VendorType.RESTAURANT, ProductType.BEVERAGE),
      ).not.toThrow();
    });

    it('RESTAURANT rejette PASTRY', () => {
      expect(() =>
        validator.assertProductTypeAllowed(VendorType.RESTAURANT, ProductType.PASTRY),
      ).toThrow(BadRequestException);
    });

    it('HOME_COOK accepte FOOD et PASTRY mais pas BEVERAGE', () => {
      expect(() =>
        validator.assertProductTypeAllowed(VendorType.HOME_COOK, ProductType.FOOD),
      ).not.toThrow();
      expect(() =>
        validator.assertProductTypeAllowed(VendorType.HOME_COOK, ProductType.PASTRY),
      ).not.toThrow();
      expect(() =>
        validator.assertProductTypeAllowed(VendorType.HOME_COOK, ProductType.BEVERAGE),
      ).toThrow(BadRequestException);
    });

    it('BAKERY accepte PASTRY et FOOD mais pas GROCERY', () => {
      expect(() =>
        validator.assertProductTypeAllowed(VendorType.BAKERY, ProductType.PASTRY),
      ).not.toThrow();
      expect(() =>
        validator.assertProductTypeAllowed(VendorType.BAKERY, ProductType.FOOD),
      ).not.toThrow();
      expect(() =>
        validator.assertProductTypeAllowed(VendorType.BAKERY, ProductType.GROCERY),
      ).toThrow(BadRequestException);
    });

    it('BEVERAGE_SHOP accepte uniquement BEVERAGE', () => {
      expect(() =>
        validator.assertProductTypeAllowed(VendorType.BEVERAGE_SHOP, ProductType.BEVERAGE),
      ).not.toThrow();
      expect(() =>
        validator.assertProductTypeAllowed(VendorType.BEVERAGE_SHOP, ProductType.FOOD),
      ).toThrow(BadRequestException);
    });

    // Pivot : pas de vente d'alcool au lancement.
    // Voir [[project-lilia-no-alcohol-initial]].
    it('ALCOHOL est rejeté quel que soit le vendorType', () => {
      for (const vendorType of Object.values(VendorType)) {
        expect(() =>
          validator.assertProductTypeAllowed(vendorType, ProductType.ALCOHOL),
        ).toThrow(/alcool/i);
      }
    });

    it('le message d\'erreur liste les types autorisés', () => {
      try {
        validator.assertProductTypeAllowed(VendorType.BAKERY, ProductType.BEVERAGE);
        fail('attendu BadRequestException');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as Error).message).toContain('PASTRY');
        expect((err as Error).message).toContain('FOOD');
      }
    });
  });

  describe('assertAvailabilityWindow', () => {
    it('ne lève rien si les deux bornes sont absentes', () => {
      expect(() => validator.assertAvailabilityWindow()).not.toThrow();
      expect(() =>
        validator.assertAvailabilityWindow(undefined, undefined),
      ).not.toThrow();
    });

    it('rejette une borne fournie sans l\'autre', () => {
      expect(() =>
        validator.assertAvailabilityWindow('07:00', undefined),
      ).toThrow(BadRequestException);
      expect(() =>
        validator.assertAvailabilityWindow(undefined, '12:00'),
      ).toThrow(BadRequestException);
    });

    it('accepte une fenêtre valide (from < until)', () => {
      expect(() =>
        validator.assertAvailabilityWindow('07:00', '12:00'),
      ).not.toThrow();
    });

    it('rejette from >= until', () => {
      expect(() =>
        validator.assertAvailabilityWindow('12:00', '07:00'),
      ).toThrow(BadRequestException);
      expect(() =>
        validator.assertAvailabilityWindow('12:00', '12:00'),
      ).toThrow(BadRequestException);
    });
  });
});
