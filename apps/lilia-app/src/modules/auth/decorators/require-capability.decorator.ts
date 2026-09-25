import { SetMetadata } from '@nestjs/common';
import { AdminCapability } from '@prisma/client';

export const REQUIRE_CAPABILITY_KEY = 'requireCapability';

/**
 * F3-08 — capacité d'administrateur exigée par une route (R-08.1).
 *
 * Le rôle `ADMIN` reste la porte d'entrée (`@Roles`) ; la capacité autorise le
 * geste. Toute route ouverte à l'ADMIN doit être classée dans
 * `admin-route-capabilities.spec.ts` : une route nouvelle non classée fait
 * échouer le test.
 */
export const RequireCapability = (capability: AdminCapability) =>
  SetMetadata(REQUIRE_CAPABILITY_KEY, capability);
