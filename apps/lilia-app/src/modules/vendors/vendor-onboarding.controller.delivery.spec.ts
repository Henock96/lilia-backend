import { ForbiddenException } from '@nestjs/common';
import { VendorOnboardingController } from './vendor-onboarding.controller';

/**
 * `PATCH /vendors/:id/delivery` — la route par laquelle l'app vendeurs
 * bascule désormais livraison et retrait (Lot 1). L'identifiant vient du
 * chemin, donc d'un client : la propriété doit être vérifiée AVANT toute
 * écriture, et un refus ne doit rien écrire.
 */
describe('VendorOnboardingController.updateDelivery — propriété', () => {
  const onboarding = { updateDelivery: jest.fn().mockResolvedValue({}) };
  const access = { verifyOwnership: jest.fn() };
  const controller = new VendorOnboardingController(
    onboarding as never,
    {} as never,
    access as never,
    {} as never,
    {} as never,
  );
  const caller = { id: 'u1', firebaseUid: 'fb-u1' } as never;

  beforeEach(() => jest.clearAllMocks());

  it('propriétaire : vérifie la propriété puis délègue au service', async () => {
    access.verifyOwnership.mockResolvedValue(undefined);
    await controller.updateDelivery('r1', { supportsPickup: false }, caller);
    expect(access.verifyOwnership).toHaveBeenCalledWith('r1', 'fb-u1');
    expect(onboarding.updateDelivery).toHaveBeenCalledWith('r1', {
      supportsPickup: false,
    });
  });

  it('vendeur d’un autre restaurant : refusé, rien n’est écrit', async () => {
    access.verifyOwnership.mockRejectedValue(new ForbiddenException());
    await expect(
      controller.updateDelivery('r-autre', { supportsDelivery: false }, caller),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(onboarding.updateDelivery).not.toHaveBeenCalled();
  });
});
