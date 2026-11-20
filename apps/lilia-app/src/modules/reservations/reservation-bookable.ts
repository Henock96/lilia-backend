import { RESERVATION_ELIGIBLE_VENDOR_TYPE } from './reservation-vocab';

/**
 * Un restaurant prend-il des réservations ? Seule règle, partagée par la
 * disponibilité (`ReservationBookingService.loadBookable`, 404
 * `RESERVATION_NOT_BOOKABLE` sinon) et par la fiche publique du vendeur
 * (`reservable`, 4C-0 / D-1) : le bouton « Réserver » de l'app client ne
 * peut donc pas promettre une table que la disponibilité refuserait.
 *
 * Ne dit rien des créneaux : un restaurant réservable peut n'en avoir aucun
 * ce jour-là (pause, fermeture, tables prises).
 */
export function isReservable(input: {
  vendorType: string;
  platformEnabled: boolean;
  settingsEnabled: boolean;
  entitled: boolean;
}): boolean {
  return (
    input.vendorType === RESERVATION_ELIGIBLE_VENDOR_TYPE &&
    input.platformEnabled &&
    input.settingsEnabled &&
    input.entitled
  );
}
