import { RestaurantPayoutService } from './services/restaurant-payout.service';

/**
 * Contribution par commande — correction des trois postes certains (P0-3 partiel).
 *
 * ## Ce que le calcul disait avant
 *
 * ```ts
 * netMargin = serviceFee + commission − collectionFee − payoutFee
 * ```
 *
 * Ce nombre était **affiché** — « Marge nette » dans `lilia-food-admin`,
 * « Marge » dans le back-office web — et omettait trois postes connus, dont
 * deux de sens opposé :
 *
 *  · les **frais de livraison** encaissés (revenu de Lilia : le client les
 *    paie, le vendeur ne les touche pas) ;
 *  · les **remises** promo et fidélité (coût de Lilia : le reversement vendeur
 *    est calculé sur le sous-total brut) ;
 *  · les **remboursements** effectivement versés.
 *
 * ## Ce que ces tests interdisent
 *
 * Le dernier de ce fichier est le plus important : **aucun coût livreur fictif**.
 * Le poste n'existe pas dans le système et aucune règle métier ne le définit.
 * Le remplacer par `0` transformerait « inconnu » en « gratuit ».
 */
describe('getOrderFinancials — contribution', () => {
  /**
   * Accès direct à la méthode de calcul : elle est privée, mais c'est elle qui
   * porte la règle. Passer par `getOrderFinancials` imposerait de simuler huit
   * requêtes Prisma pour tester une arithmétique.
   */
  const contribution = (
    order: Record<string, unknown>,
    breakdown: { commissionAmount: number },
    fees: { collectionFee: number | null; payoutFee: number | null },
  ) =>
    (
      RestaurantPayoutService.prototype as unknown as {
        buildContribution: (
          o: unknown,
          b: unknown,
          f: unknown,
        ) => Record<string, unknown>;
      }
    ).buildContribution(order, breakdown, fees);

  /** Panier type observé en production le 14/09/2026. */
  const TYPICAL = {
    deliveryFee: 1000,
    serviceFee: 320,
    discountAmount: 0,
    loyaltyDiscount: 0,
    isDelivery: true,
    refund: null,
  };
  const COMMISSION = { commissionAmount: 400 };
  const FEES = { collectionFee: 120, payoutFee: 75 };

  describe('frais de livraison — revenu omis', () => {
    it('les compte dans le revenu de Lilia', () => {
      const result = contribution(TYPICAL, COMMISSION, FEES);

      // 320 (service) + 400 (commission) + 1 000 (livraison)
      expect(result.revenue).toBe(1720);
      expect(result.deliveryFeeCollected).toBe(1000);
    });

    it('sur un retrait au comptoir, il n’y a pas de frais à compter', () => {
      const result = contribution(
        { ...TYPICAL, isDelivery: false, deliveryFee: 0 },
        COMMISSION,
        FEES,
      );

      expect(result.revenue).toBe(720);
    });
  });

  describe('remises — coût omis, jamais compté deux fois', () => {
    it('déduit `discountAmount` du revenu', () => {
      const result = contribution(
        { ...TYPICAL, isDelivery: false, deliveryFee: 0, discountAmount: 500 },
        COMMISSION,
        FEES,
      );

      // 500 (remise) + 120 + 75
      expect(result.variableCosts).toBe(695);
      expect(result.contributionMargin).toBe(720 - 695);
    });

    it('ne compte PAS la fidélité deux fois', () => {
      // `discountAmount` = promo + fidélité ; `loyaltyDiscount` en est une
      // sous-partie. Les additionner surestimerait le coût — et présenterait
      // une marge trop basse, ce qui est aussi faux que trop haute.
      const result = contribution(
        {
          ...TYPICAL,
          isDelivery: false,
          deliveryFee: 0,
          discountAmount: 500, // dont 200 de fidélité
          loyaltyDiscount: 200,
        },
        COMMISSION,
        FEES,
      );

      expect(result.variableCosts).toBe(500 + 120 + 75);
      // Exposée pour la lecture, jamais additionnée.
      expect(result.loyaltyDiscount).toBe(200);
    });
  });

  describe('remboursements', () => {
    it('un remboursement COMPLETED est déduit', () => {
      const result = contribution(
        {
          ...TYPICAL,
          isDelivery: false,
          deliveryFee: 0,
          refund: { status: 'COMPLETED', amount: 5320 },
        },
        COMMISSION,
        FEES,
      );

      expect(result.refundPaid).toBe(5320);
      expect(result.variableCosts).toBe(5320 + 120 + 75);
      expect(result.contributionMargin).toBe(720 - (5320 + 120 + 75));
    });

    it('un remboursement PENDING n’est PAS déduit', () => {
      // C'est une dette, pas une sortie d'argent : un remboursement peut être
      // `REJECTED`. La déduire annoncerait une perte qui pourrait ne jamais
      // survenir.
      const result = contribution(
        {
          ...TYPICAL,
          isDelivery: false,
          deliveryFee: 0,
          refund: { status: 'PENDING', amount: 5320 },
        },
        COMMISSION,
        FEES,
      );

      expect(result.refundPaid).toBe(0);
      expect(result.variableCosts).toBe(195);
    });

    it('un remboursement PROCESSING non plus', () => {
      const result = contribution(
        {
          ...TYPICAL,
          isDelivery: false,
          deliveryFee: 0,
          refund: { status: 'PROCESSING', amount: 1000 },
        },
        COMMISSION,
        FEES,
      );

      expect(result.refundPaid).toBe(0);
    });
  });

  describe('coût livreur — le poste qui manque', () => {
    it('une commande LIVRÉE n’a pas de contribution calculable', () => {
      const result = contribution(TYPICAL, COMMISSION, FEES);

      expect(result.contributionMargin).toBeNull();
      expect(result.missingInputs).toContain('driverCost');
    });

    it('`netMargin` suit : `null` lui aussi, au lieu d’un chiffre faux', () => {
      // L'ancien calcul rendait 525 XAF sur cette commande. Les deux
      // back-offices l'affichaient. Le revenu réel avant course est de
      // 1 720 XAF ; ce que la course coûte, personne ne le sait.
      const result = contribution(TYPICAL, COMMISSION, FEES);

      expect(result.netMargin).toBeNull();
      expect(result.netMargin).toBe(result.contributionMargin);
    });

    it('une commande À EMPORTER a une contribution complète', () => {
      // Pas de livreur, donc rien d'inconnu : le calcul est rendu.
      const result = contribution(
        { ...TYPICAL, isDelivery: false, deliveryFee: 0 },
        COMMISSION,
        FEES,
      );

      expect(result.missingInputs).toEqual([]);
      expect(result.contributionMargin).toBe(720 - 195);
    });

    it('AUCUN coût livreur fictif n’est introduit — ni 0, ni estimation', () => {
      const result = contribution(TYPICAL, COMMISSION, FEES);

      // La règle métier n'existe pas (décisions D1–D4). Le seul comportement
      // honnête est de ne rien inventer et de nommer le manque.
      expect(Object.keys(result)).not.toContain('driverCost');
      expect(result.variableCosts).toBe(195); // uniquement les frais connus
      expect(result.missingInputs).toContain('driverCost');
    });
  });

  describe('frais prestataire inconnus', () => {
    it('un `collectionFee` absent suffit à rendre la contribution incalculable', () => {
      const result = contribution(
        { ...TYPICAL, isDelivery: false, deliveryFee: 0 },
        COMMISSION,
        { collectionFee: null, payoutFee: 75 },
      );

      expect(result.contributionMargin).toBeNull();
      expect(result.missingInputs).toEqual(['collectionFee']);
    });

    it('un `payoutFee` absent aussi — comportement conservé', () => {
      const result = contribution(
        { ...TYPICAL, isDelivery: false, deliveryFee: 0 },
        COMMISSION,
        { collectionFee: 120, payoutFee: null },
      );

      expect(result.contributionMargin).toBeNull();
      expect(result.missingInputs).toEqual(['payoutFee']);
    });

    it('sur une livraison, les trois manques sont nommés', () => {
      const result = contribution(TYPICAL, COMMISSION, {
        collectionFee: null,
        payoutFee: null,
      });

      expect(result.missingInputs).toEqual([
        'collectionFee',
        'payoutFee',
        'driverCost',
      ]);
    });
  });
});
