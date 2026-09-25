import type { PlatformSettingsService } from '../platform-settings/platform-settings.service';

/**
 * L'interrupteur `PlatformSettings.modifiersEnabled`, lu par les lectures de
 * catalogue. Sans service (test unitaire monté seul), les options sont
 * **éteintes** : c'est la valeur par défaut en base, et la carte d'avant F3-09.
 *
 * Le panier et le checkout, eux, injectent le service sans `@Optional` : la
 * décision de facturer ne peut pas dépendre d'un câblage oublié.
 */
export async function modifiersEnabled(
  settings: PlatformSettingsService | undefined,
): Promise<boolean> {
  if (!settings) return false;
  return (await settings.getSettings()).modifiersEnabled;
}
