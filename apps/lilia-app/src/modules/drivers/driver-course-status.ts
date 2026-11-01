/**
 * Situation de paie d'une course livreur — vue ADMIN (durcissement lot 3,
 * point 5). Le livreur ne voit jamais sa paie (D-PAY) : cette classification
 * n'est servie que par `admin/driver-settlements`.
 *
 * Mêmes règles que `DriverSettlementService.payableWhere`, qui décide de ce
 * qui entre dans un règlement — la vue ne peut pas annoncer « à recevoir » ce
 * que l'enregistrement refuserait :
 *
 *  - `SETTLED`     — rattachée à un règlement `PAID` (référence connue) ;
 *  - `PAYABLE`     — livrée (ou échouée sans faute du livreur, arbitrée),
 *                    paie figée, pas encore réglée ;
 *  - `RETAINED`    — échec imputé au livreur : rien n'est dû ;
 *  - `DISPUTED`    — échec déclaré, pas encore arbitré : en litige ;
 *  - `UNKNOWN_PAY` — terminée sans économie figée : montant inconnu, on ne
 *                    l'invente pas ;
 *  - `IN_PROGRESS` — course en cours.
 */
export type DriverCourseStatus =
  | 'SETTLED'
  | 'PAYABLE'
  | 'RETAINED'
  | 'DISPUTED'
  | 'UNKNOWN_PAY'
  | 'IN_PROGRESS';

export interface DriverCourseFacts {
  deliveryStatus: string;
  orderStatus: string;
  failureLiability: string | null;
  economicsFrozen: boolean;
  settlementStatus: string | null;
}

const NOT_DRIVER_FAULT = ['CLIENT', 'VENDOR', 'PLATFORM'];

export function driverCourseStatus(c: DriverCourseFacts): DriverCourseStatus {
  if (c.settlementStatus === 'PAID') return 'SETTLED';

  if (c.deliveryStatus === 'LIVRER') {
    return c.economicsFrozen ? 'PAYABLE' : 'UNKNOWN_PAY';
  }

  if (c.deliveryStatus === 'ECHEC') {
    const concluded = c.orderStatus === 'ECHEC_LIVRAISON';
    if (!concluded || !c.failureLiability) return 'DISPUTED';
    if (c.failureLiability === 'DRIVER') return 'RETAINED';
    if (NOT_DRIVER_FAULT.includes(c.failureLiability)) {
      return c.economicsFrozen ? 'PAYABLE' : 'UNKNOWN_PAY';
    }
    return 'DISPUTED';
  }

  return 'IN_PROGRESS';
}
