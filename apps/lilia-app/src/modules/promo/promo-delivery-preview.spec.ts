import { PromoService } from './promo.service';
import { cartLine } from '../modifiers/testing/cart-line.fixture';

/**
 * Aperçu `POST /promo/validate` d'un code `FREE_DELIVERY` (F3-02).
 *
 * En mode PLATFORM, le prix de la course vient de la grille : l'aperçu
 * annonçait l'offre de `fixedDeliveryFee`, un prix que le checkout ne
 * facture plus. Il doit chiffrer par le même devis que le checkout.
 */
describe('PromoService.validateCodeForCart — frais de livraison de l’aperçu', () => {
  function build(quote: { customerFeeXaf: number } | null) {
    const prisma = {
      cart: {
        findUnique: jest.fn().mockResolvedValue({
          items: [
            cartLine({
              quantite: 2,
              variant: { prix: 2500 },
              product: { restaurantId: 'r1' },
            }),
          ],
        }),
      },
      restaurant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'r1',
          fixedDeliveryFee: 1000,
          latitude: null,
          longitude: null,
          quartierId: 'q-poto',
          deliverySubsidyMode: 'NONE',
          deliverySubsidyXaf: null,
          freeDeliveryThresholdXaf: null,
        }),
      },
    };
    const deliveryPricing = {
      quoteForVendor: jest.fn().mockResolvedValue(quote),
    };
    const service = new PromoService(
      prisma as never,
      deliveryPricing as never,
      {
        getSettings: async () => ({ modifiersEnabled: false }),
      } as never,
    );
    const validateCode = jest
      .spyOn(service, 'validateCode')
      .mockResolvedValue({} as never);
    return { service, validateCode, deliveryPricing };
  }

  it('mode PLATFORM : le prix client du devis, pas le prix du vendeur', async () => {
    const { service, validateCode, deliveryPricing } = build({
      customerFeeXaf: 1500,
    });
    await service.validateCodeForCart('LIVRAISON', 'u1', 'q-talangai');

    expect(deliveryPricing.quoteForVendor).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: {
          quartierId: 'q-talangai',
          latitude: null,
          longitude: null,
        },
        subTotalXaf: 5000,
      }),
    );
    expect(validateCode).toHaveBeenCalledWith(
      'LIVRAISON',
      'u1',
      'r1',
      5000,
      1500,
    );
  });

  it('mode VENDOR_LEGACY : l’ancien aperçu, inchangé', async () => {
    const { service, validateCode } = build(null);
    await service.validateCodeForCart('LIVRAISON', 'u1');

    expect(validateCode).toHaveBeenCalledWith(
      'LIVRAISON',
      'u1',
      'r1',
      5000,
      1000,
    );
  });
});
