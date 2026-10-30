import { collectPublicRoutes } from '../../test/public-routes';

/**
 * F-32 (audit du 28/10/2026) — classement de TOUTES les routes `@Public()`.
 *
 * Les fuites de projection publique sont revenues trois fois
 * (`payoutPhoneNumber` ×2, `GET /reviews/:id`), toujours par un `include:` ou
 * une route ajoutée sans qu'on se demande ce qu'elle expose. Ce test fait
 * échouer la CI quand une route publique apparaît sans être classée : la
 * question se pose donc au moment où la route est écrite.
 *
 * Classes :
 * - `VENDOR_PROJECTION` : `PUBLIC_VENDOR_SELECT` / vue carte vendeur, testées
 *   par `vendor-public-projection.spec.ts` et `vendor-menu-parity.spec.ts` ;
 * - `REVIEW_PROJECTION`, `BANNER_PROJECTION` : listes blanches dédiées ;
 * - `MAPPED` : réponse construite champ par champ dans le service ;
 * - `CATALOGUE_INCLUDE` : `include:` limité à des modèles de catalogue (aucune
 *   donnée personnelle ni financière à ce jour) — à convertir en liste
 *   blanche, inscrit au backlog ;
 * - `PROVIDER_CALLBACK` : webhook authentifié par signature / liste blanche ;
 * - `HEALTH` : sonde technique ;
 * - `TO_AUDIT` : projection non relue ligne à ligne lors de l'audit du
 *   28/10/2026 — classée pour ne pas bloquer, mais pas déclarée sûre.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  'BannersController.findAll': 'BANNER_PROJECTION',
  'BannersController.findOne': 'BANNER_PROJECTION',
  'HealthController.check': 'HEALTH',
  'HealthController.checkFirebase': 'HEALTH',
  'HealthController.live': 'HEALTH',
  'HealthController.ready': 'HEALTH',
  'MenuImagesController.list': 'TO_AUDIT',
  'MenusController.findAll': 'CATALOGUE_INCLUDE',
  'MenusController.getActiveMenus': 'CATALOGUE_INCLUDE',
  'PawaPayWebhookController.handleDepositCallback': 'PROVIDER_CALLBACK',
  'PawaPayWebhookController.handlePayoutCallback': 'PROVIDER_CALLBACK',
  'PaymentController.listProviders': 'MAPPED',
  'ProductImagesController.list': 'TO_AUDIT',
  'ProductsController.findAll': 'TO_AUDIT',
  'ProductsController.findAvailableNow': 'TO_AUDIT',
  'ProductsController.findOne': 'TO_AUDIT',
  'ProductsController.findPopular': 'TO_AUDIT',
  'ProductsController.search': 'TO_AUDIT',
  'PublicPlatformSettingsController.get': 'MAPPED',
  'QuartiersController.calculateDeliveryFee': 'MAPPED',
  'QuartiersController.findAll': 'TO_AUDIT',
  'QuartiersController.getRestaurantDeliveryZones': 'MAPPED',
  'RestaurantsController.findAll': 'VENDOR_PROJECTION',
  'RestaurantsController.findOne': 'VENDOR_PROJECTION',
  'RestaurantsController.findPopular': 'VENDOR_PROJECTION',
  'RestaurantsController.getOperatingHours': 'TO_AUDIT',
  'RestaurantsController.getSpecialties': 'TO_AUDIT',
  'ReviewsController.findByRestaurant': 'REVIEW_PROJECTION',
  'ReviewsController.findOne': 'REVIEW_PROJECTION',
  'ReviewsController.getStats': 'MAPPED',
  'VendorPhotosController.list': 'TO_AUDIT',
  'VendorsController.findAll': 'VENDOR_PROJECTION',
  'VendorsController.findOne': 'VENDOR_PROJECTION',
  'WeatherController.brazzaville': 'MAPPED',
  'WebhookController.handleMtnMomoWebhook': 'PROVIDER_CALLBACK',
};

describe('Routes publiques — classement obligatoire (F-32)', () => {
  const routes = collectPublicRoutes();

  it('toute route @Public() est classée', () => {
    const unclassified = routes.filter((r) => !(r in PUBLIC_ROUTES));
    expect({ nonClassees: unclassified }).toEqual({ nonClassees: [] });
  });

  it('la table ne garde pas de route disparue', () => {
    const stale = Object.keys(PUBLIC_ROUTES).filter((k) => !routes.includes(k));
    expect({ disparues: stale }).toEqual({ disparues: [] });
  });
});
