import { ConflictException } from '@nestjs/common';
import { PlatformSettings } from '@prisma/client';
import { getMetadataStorage } from 'class-validator';

import {
  assertDeliveryPricingSwitch,
  describeFinancialChange,
  FINANCIAL_SETTING_KEYS,
  financialChanges,
  financialSnapshot,
  staleFinancialKeys,
} from './financial-settings';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';

const current = {
  id: 'singleton',
  serviceFeePercent: 15,
  groceryServiceFeeBps: null,
  restaurantCommissionPercent: 10,
  loyaltyPointValueXaf: 50,
  loyaltyPointsPerOrder: 1,
  loyaltyMinRedemption: 1,
  referrerBonusPoints: 1,
  vendorPayoutAutoEnabled: false,
  vendorPayoutDelayMinutes: 60,
  deliveryPricingMode: 'VENDOR_LEGACY',
  maintenanceMode: false,
} as unknown as PlatformSettings;

describe('Réglages financiers (R-09)', () => {
  it('chaque réglage financier est un champ du PATCH : la liste ne vise rien d’inexistant', () => {
    // Un nom mal orthographié ici laisserait le vrai champ passer par le PATCH.
    // Les champs acceptés par le PATCH sont ceux que class-validator connaît.
    const validated = new Set(
      getMetadataStorage()
        .getTargetValidationMetadatas(
          UpdatePlatformSettingsDto,
          '',
          false,
          false,
        )
        .map((m) => m.propertyName),
    );
    for (const key of FINANCIAL_SETTING_KEYS) {
      expect({
        key,
        inDto: validated.has(key),
        inModel: key in current,
      }).toEqual({
        key,
        inDto: true,
        inModel: true,
      });
    }
  });

  describe('financialChanges', () => {
    it('ne retient que les valeurs qui diffèrent', () => {
      expect(
        financialChanges(current, {
          serviceFeePercent: 15,
          loyaltyPointValueXaf: 40,
          maintenanceMode: true,
        }),
      ).toEqual({ loyaltyPointValueXaf: 40 });
    });

    it('null sur un taux posé est un changement (retour au taux général)', () => {
      const withGrocery = {
        ...current,
        groceryServiceFeeBps: 500,
      } as PlatformSettings;
      expect(
        financialChanges(withGrocery, { groceryServiceFeeBps: null }),
      ).toEqual({
        groceryServiceFeeBps: null,
      });
    });

    it('undefined n’est pas un changement', () => {
      expect(
        financialChanges(current, { serviceFeePercent: undefined }),
      ).toEqual({});
    });
  });

  it('financialSnapshot photographie les seuls champs visés', () => {
    expect(
      financialSnapshot(current, ['serviceFeePercent', 'groceryServiceFeeBps']),
    ).toEqual({ serviceFeePercent: 15, groceryServiceFeeBps: null });
  });

  it('staleFinancialKeys signale un champ qui a bougé depuis la demande', () => {
    const moved = { ...current, serviceFeePercent: 14 } as PlatformSettings;
    expect(
      staleFinancialKeys(moved, {
        serviceFeePercent: 15,
        loyaltyPointValueXaf: 50,
      }),
    ).toEqual(['serviceFeePercent']);
    expect(staleFinancialKeys(current, { serviceFeePercent: 15 })).toEqual([]);
  });

  it('describeFinancialChange rend un résumé lisible par le second administrateur', () => {
    expect(
      describeFinancialChange({
        changes: {
          serviceFeePercent: 12,
          groceryServiceFeeBps: 500,
          vendorPayoutAutoEnabled: true,
          deliveryPricingMode: 'PLATFORM',
        },
        before: {
          serviceFeePercent: 15,
          groceryServiceFeeBps: null,
          vendorPayoutAutoEnabled: false,
          deliveryPricingMode: 'VENDOR_LEGACY',
        },
      }),
    ).toBe(
      'Frais de service : 15 % → 12 % ; Frais de service épiceries : taux général → 5 % ; ' +
        'Versements automatiques : désactivés → activés ; ' +
        'Tarification de la livraison : prix du vendeur → grille plateforme',
    );
  });

  /**
   * F3-02 — en mode PLATFORM, un checkout sans grille publiée est refusé.
   * Basculer sans grille fermerait la caisse de toute la plateforme.
   */
  describe('assertDeliveryPricingSwitch (F3-02)', () => {
    const client = (published: number) => ({
      deliveryTariff: { count: jest.fn().mockResolvedValue(published) },
    });

    it('refuse de passer en PLATFORM sans grille publiée (409, code distinct)', async () => {
      const c = client(0);
      const error = await assertDeliveryPricingSwitch(
        c as never,
        'VENDOR_LEGACY',
        'PLATFORM',
      ).catch((e: ConflictException) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'DELIVERY_TARIFF_NOT_PUBLISHED',
        message: expect.stringContaining('Publiez une grille'),
      });
      expect(c.deliveryTariff.count).toHaveBeenCalledWith({
        where: { status: 'PUBLISHED' },
      });
    });

    it('passe en PLATFORM quand une grille est publiée', async () => {
      await expect(
        assertDeliveryPricingSwitch(
          client(1) as never,
          'VENDOR_LEGACY',
          'PLATFORM',
        ),
      ).resolves.toBeUndefined();
    });

    it('le retour à VENDOR_LEGACY n’exige rien : c’est la sortie de secours', async () => {
      const c = client(0);
      await assertDeliveryPricingSwitch(
        c as never,
        'PLATFORM',
        'VENDOR_LEGACY',
      );
      expect(c.deliveryTariff.count).not.toHaveBeenCalled();
    });

    it('sans bascule demandée, rien n’est vérifié', async () => {
      const c = client(0);
      await assertDeliveryPricingSwitch(c as never, 'VENDOR_LEGACY', undefined);
      expect(c.deliveryTariff.count).not.toHaveBeenCalled();
    });
  });
});
