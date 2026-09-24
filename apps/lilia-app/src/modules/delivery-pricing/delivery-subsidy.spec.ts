import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateDeliverySubsidyDto } from './dto/update-delivery-subsidy.dto';
import { deliverySubsidyData } from './delivery-subsidy';

/**
 * Réglage « offrir une partie de la livraison » (F3-02, R-02.4).
 *
 * Le vendeur ne fixe plus le prix de la course : il choisit seulement d'en
 * offrir une part à son client, prise sur son propre reversement.
 */
const errorsOf = async (body: object) =>
  (await validate(plainToInstance(UpdateDeliverySubsidyDto, body))).map(
    (e) => e.property,
  );

describe('UpdateDeliverySubsidyDto', () => {
  it('NONE ne demande rien', async () => {
    expect(await errorsOf({ mode: 'NONE' })).toEqual([]);
  });

  it('FIXED exige un montant entier positif', async () => {
    expect(await errorsOf({ mode: 'FIXED' })).toEqual(['amountXaf']);
    expect(await errorsOf({ mode: 'FIXED', amountXaf: 0 })).toEqual([
      'amountXaf',
    ]);
    expect(await errorsOf({ mode: 'FIXED', amountXaf: 12.5 })).toEqual([
      'amountXaf',
    ]);
    expect(await errorsOf({ mode: 'FIXED', amountXaf: 500 })).toEqual([]);
  });

  it('FREE_ABOVE exige un seuil entier positif', async () => {
    expect(await errorsOf({ mode: 'FREE_ABOVE' })).toEqual(['thresholdXaf']);
    expect(await errorsOf({ mode: 'FREE_ABOVE', thresholdXaf: 10000 })).toEqual(
      [],
    );
  });

  it('refuse un mode inconnu', async () => {
    expect(await errorsOf({ mode: 'ALWAYS_FREE' })).toEqual(['mode']);
  });
});

describe('deliverySubsidyData', () => {
  it('NONE efface montant et seuil', () => {
    expect(
      deliverySubsidyData({ mode: 'NONE', amountXaf: 500, thresholdXaf: 900 }),
    ).toEqual({
      deliverySubsidyMode: 'NONE',
      deliverySubsidyXaf: null,
      freeDeliveryThresholdXaf: null,
    });
  });

  it('FIXED ne garde que le montant', () => {
    expect(
      deliverySubsidyData({ mode: 'FIXED', amountXaf: 500, thresholdXaf: 900 }),
    ).toEqual({
      deliverySubsidyMode: 'FIXED',
      deliverySubsidyXaf: 500,
      freeDeliveryThresholdXaf: null,
    });
  });

  it('FREE_ABOVE ne garde que le seuil', () => {
    expect(
      deliverySubsidyData({
        mode: 'FREE_ABOVE',
        amountXaf: 500,
        thresholdXaf: 10000,
      }),
    ).toEqual({
      deliverySubsidyMode: 'FREE_ABOVE',
      deliverySubsidyXaf: null,
      freeDeliveryThresholdXaf: 10000,
    });
  });
});
