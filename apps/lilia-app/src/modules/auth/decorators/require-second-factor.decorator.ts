import { SetMetadata } from '@nestjs/common';

export const REQUIRE_SECOND_FACTOR_KEY = 'requireSecondFactor';

/**
 * Lot 1C (ADM-05, D-2) — geste ADMIN sensible sans capacité financière :
 * annuler une commande, suspendre un vendeur, assigner un livreur…
 *
 * Quand `ADMIN_SECOND_FACTOR_ENFORCED` est allumé, un ADMIN dont le jeton ne
 * porte pas de second facteur reçoit 401 `MFA_SESSION_REQUIRED` : il doit se
 * reconnecter avec son code. Le RESTAURATEUR n'est jamais concerné, même sur
 * une route partagée. Pas de fenêtre de 15 minutes : celle-ci reste réservée
 * aux capacités `FINANCE_*`.
 *
 * Classée `SECOND_FACTOR` dans `admin-route-capabilities.spec.ts`.
 */
export const RequireSecondFactor = () =>
  SetMetadata(REQUIRE_SECOND_FACTOR_KEY, true);
