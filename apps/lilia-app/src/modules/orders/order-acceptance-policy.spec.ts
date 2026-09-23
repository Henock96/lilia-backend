import { acceptanceDeadline } from './order-acceptance-policy';

/**
 * Échéance d'acceptation d'une commande payée (F3-01, décision D1 = 8 min).
 *
 * Fonction pure : c'est elle qui décide quand une commande sera annulée et
 * remboursée faute de réponse du vendeur. Chaque borne a sa ligne.
 */
describe('acceptanceDeadline', () => {
  const paidAt = new Date('2026-09-24T12:00:00.000Z');
  const settings = {
    vendorAcceptanceTimeoutMinutes: 8,
    preorderAcceptanceHours: 2,
  };
  const minutes = (n: number) => new Date(paidAt.getTime() + n * 60_000);
  const hours = (n: number) => minutes(n * 60);

  it('commande immédiate : paiement + délai plateforme', () => {
    expect(
      acceptanceDeadline(
        {
          paidAt,
          isPreorder: false,
          scheduledFor: null,
          preorderLeadHours: null,
        },
        settings,
      ),
    ).toEqual(minutes(8));
  });

  it('suit le délai plateforme, pas une constante', () => {
    expect(
      acceptanceDeadline(
        {
          paidAt,
          isPreorder: false,
          scheduledFor: null,
          preorderLeadHours: null,
        },
        { ...settings, vendorAcceptanceTimeoutMinutes: 12 },
      ),
    ).toEqual(minutes(12));
  });

  it('précommande lointaine : paiement + délai de précommande', () => {
    expect(
      acceptanceDeadline(
        {
          paidAt,
          isPreorder: true,
          scheduledFor: hours(48),
          preorderLeadHours: 24,
        },
        settings,
      ),
    ).toEqual(hours(2));
  });

  it('précommande proche : borne par l’heure de livraison moins la préparation', () => {
    // Livraison dans 3 h, 2 h de préparation : le vendeur doit avoir répondu
    // dans l'heure, pas dans deux.
    expect(
      acceptanceDeadline(
        {
          paidAt,
          isPreorder: true,
          scheduledFor: hours(3),
          preorderLeadHours: 2,
        },
        settings,
      ),
    ).toEqual(hours(1));
  });

  it('jamais en dessous du délai d’une commande immédiate', () => {
    // Heure de livraison déjà trop proche (données incohérentes ou course) :
    // on ne crée pas une commande qui expire à la seconde du paiement.
    expect(
      acceptanceDeadline(
        {
          paidAt,
          isPreorder: true,
          scheduledFor: minutes(30),
          preorderLeadHours: 24,
        },
        settings,
      ),
    ).toEqual(minutes(8));
  });

  it('précommande sans heure de livraison : délai de précommande seul', () => {
    expect(
      acceptanceDeadline(
        { paidAt, isPreorder: true, scheduledFor: null, preorderLeadHours: 24 },
        settings,
      ),
    ).toEqual(hours(2));
  });
});
