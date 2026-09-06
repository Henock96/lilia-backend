import { BadRequestException } from '@nestjs/common';
import { DeliveryPriceMode } from '@prisma/client';

/**
 * L'invariant de la tarification par zone, écrit une seule fois.
 *
 * ### Le défaut corrigé (L-3, audit du 05/09/2026)
 *
 * La règle « en `ZONE_BASED`, il faut au moins une zone » existait — mais
 * uniquement dans `VendorReadinessService.checkDelivery`, c'est-à-dire dans la
 * **checklist d'activation**. Elle gardait donc la porte d'entrée du catalogue
 * et rien d'autre : une fois le vendeur `ACTIVATED`, trois chemins la
 * contournaient sans un mot —
 *
 * - `PATCH /restaurants/:id/delivery-settings`
 * - `PATCH /vendors/:id/delivery`
 * - `DELETE /quartiers/zones/:zoneId` (sur la dernière zone)
 *
 * Le résultat est visible en production : « Le Cosy Lounge Brazza » est en
 * `ZONE_BASED` avec **zéro zone**, et chacune de ses livraisons est facturée au
 * tarif de repli sans que rien ne le signale. Un invariant vérifié au moment de
 * l'admission mais pas au moment de l'écriture ne protège que les nouveaux.
 *
 * ### Pourquoi un prédicat *et* une assertion
 *
 * Deux appelants ont besoin de la même règle sous deux formes : la checklist
 * d'onboarding la **présente** (elle liste ce qui manque sans rien interrompre),
 * les services d'écriture la **font respecter** (ils refusent). Les écrire deux
 * fois, c'est accepter qu'elles divergent — c'est exactement comme ça que
 * `isWithinAvailabilityWindow` et `availableProductWhere` s'étaient mises à
 * diverger sur 17 des 49 cas. Le prédicat est donc la source, l'exception n'en
 * est qu'une mise en forme.
 */
export function isZoneCoverageMissing(
  mode: DeliveryPriceMode,
  zoneCount: number,
  supportsDelivery = true,
): boolean {
  // Un vendeur qui ne livre pas (retrait uniquement) n'a pas de zones à
  // définir : son mode de tarification ne sert à rien et ne doit rien bloquer.
  return (
    supportsDelivery && mode === DeliveryPriceMode.ZONE_BASED && zoneCount === 0
  );
}

/** Message unique — l'admin, le vendeur et la checklist lisent la même phrase. */
export const ZONE_COVERAGE_REQUIRED_MESSAGE =
  'Au moins une zone de livraison doit être configurée pour activer la ' +
  'tarification par zone. Créez vos zones avant de basculer dans ce mode, ' +
  'sinon toutes les livraisons seraient facturées au tarif de repli.';

export function assertZoneCoverage(
  mode: DeliveryPriceMode,
  zoneCount: number,
  supportsDelivery = true,
): void {
  if (isZoneCoverageMissing(mode, zoneCount, supportsDelivery)) {
    throw new BadRequestException(ZONE_COVERAGE_REQUIRED_MESSAGE);
  }
}

/** Refus symétrique : retirer la dernière zone d'un vendeur qui en dépend. */
export const LAST_ZONE_MESSAGE =
  'Cette zone est la dernière du vendeur, qui facture à la zone. La ' +
  'supprimer ferait basculer toutes ses livraisons sur le tarif de repli. ' +
  'Repassez-le en tarif fixe, ou créez une autre zone d’abord.';

export function assertNotLastZoneOfZoneBasedVendor(
  mode: DeliveryPriceMode,
  zoneCountAfterDeletion: number,
  supportsDelivery = true,
): void {
  if (isZoneCoverageMissing(mode, zoneCountAfterDeletion, supportsDelivery)) {
    throw new BadRequestException(LAST_ZONE_MESSAGE);
  }
}
