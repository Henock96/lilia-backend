import type { PlatformSettingsService } from '../platform-settings/platform-settings.service';

/**
 * F3-11 — interrupteur des offres boutique, pour les lectures publiques.
 * Service absent (tests qui montent un service seul) = éteint : la réponse
 * est celle d'avant F3-11, `activeOffer: null`.
 */
export async function vendorOffersEnabled(
  settings: PlatformSettingsService | undefined,
): Promise<boolean> {
  if (!settings) return false;
  return (await settings.getSettings()).vendorOffersEnabled;
}
