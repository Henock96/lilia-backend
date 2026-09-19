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

  /**
   * Le coût livreur, désormais lu sur le snapshot de la course.
   *
   * ⚠️ `driverCost` ne vient PAS d'un calcul fait ici : il est figé sur la
   * `Delivery` à l'acceptation du livreur. Le recalculer à la lecture ferait
   * varier une commande passée au rythme des changements de taux — c'est
   * exactement le défaut que la commission vendeur a coûté.
   */
  describe('coût livreur — lu sur le snapshot de la course', () => {
    const FROZEN = {
      driverBaseXaf: 1000,
      driverPayXaf: 350,
      driverSharePercent: 35,
      driverEmploymentType: 'LILIA',
      driverCompensationModel: 'PER_DELIVERY',
      driverEconomicsFrozenAt: new Date('2026-09-18T10:00:00Z'),
    };

    it('course gelée : le coût est connu et sort de `missingInputs`', () => {
      const c = contribution(
        { ...TYPICAL, delivery: FROZEN },
        COMMISSION,
        FEES,
      );

      expect(c.driverCost).toBe(350);
      expect(c.missingInputs).not.toContain('driverCost');
    });

    it('la part de Lilia sur la course est rendue, et c’est le résidu', () => {
      const c = contribution(
        { ...TYPICAL, delivery: FROZEN },
        COMMISSION,
        FEES,
      );

      expect(c.liliaDeliveryShare).toBe(650);
      expect((c.driverCost as number) + (c.liliaDeliveryShare as number)).toBe(
        FROZEN.driverBaseXaf,
      );
    });

    it('le coût livreur est bien DÉDUIT des coûts variables', () => {
      const sans = contribution(
        { ...TYPICAL, delivery: null },
        COMMISSION,
        FEES,
      );
      const avec = contribution(
        { ...TYPICAL, delivery: FROZEN },
        COMMISSION,
        FEES,
      );

      expect(
        (avec.variableCosts as number) - (sans.variableCosts as number),
      ).toBe(350);
    });

    it('course NON gelée : le coût reste inconnu', () => {
      // Assigné mais pas encore accepté : aucun livreur ne s'est engagé.
      const c = contribution(
        {
          ...TYPICAL,
          delivery: {
            ...FROZEN,
            driverEconomicsFrozenAt: null,
            driverPayXaf: null,
          },
        },
        COMMISSION,
        FEES,
      );

      expect(c.driverCost).toBeNull();
      expect(c.missingInputs).toContain('driverCost');
    });

    it('livraison SANS ligne de course : inconnu — le cas existe en production', () => {
      // 7 commandes livrées n'ont aucune `Delivery` : livrées hors système.
      const c = contribution({ ...TYPICAL, delivery: null }, COMMISSION, FEES);

      expect(c.driverCost).toBeNull();
      expect(c.missingInputs).toContain('driverCost');
    });

    it('livreur au SALAIRE : coût 0, et ce zéro NE bloque PAS la contribution', () => {
      // Le seul cas où 0 est la bonne réponse et où elle est connue. C'est
      // `driverCompensationModel` qui le rend lisible, pas le montant.
      const c = contribution(
        {
          ...TYPICAL,
          delivery: {
            ...FROZEN,
            driverPayXaf: 0,
            driverSharePercent: null,
            driverCompensationModel: 'SALARY',
          },
        },
        COMMISSION,
        FEES,
      );

      expect(c.driverCost).toBe(0);
      expect(c.driverCompensationModel).toBe('SALARY');
      expect(c.missingInputs).not.toContain('driverCost');
    });

    it('retrait au comptoir : pas de course, donc pas de poste manquant', () => {
      const c = contribution(
        { ...TYPICAL, isDelivery: false, deliveryFee: 0, delivery: null },
        COMMISSION,
        FEES,
      );

      expect(c.driverCost).toBeNull();
      expect(c.missingInputs).not.toContain('driverCost');
    });
  });

  /**
   * La contribution AVANT frais prestataire.
   *
   * `collectionFeeXaf` et `payoutFeeXaf` ne sont **jamais écrits** : nos types
   * pawaPay ne modélisent aucun frais, et la production n'a jamais reçu un seul
   * webhook. Bloquer la marge sur eux revient à ne jamais l'afficher — ce que
   * le code lui-même déplorait déjà (« patienter pour une information qui
   * n'arrivera jamais »).
   *
   * On rend donc DEUX nombres, jamais confondus : la contribution stricte
   * (`null` tant qu'un poste manque) et celle hors frais prestataire, qui est
   * exacte dès que le coût livreur est connu. Un nombre vrai et nommé pour ce
   * qu'il est vaut mieux qu'un tiret.
   */
  describe('contribution hors frais prestataire', () => {
    const FROZEN = {
      driverBaseXaf: 1000,
      driverPayXaf: 350,
      driverSharePercent: 35,
      driverEmploymentType: 'LILIA',
      driverCompensationModel: 'PER_DELIVERY',
      driverEconomicsFrozenAt: new Date(),
    };
    const NO_FEES = { collectionFee: null, payoutFee: null };

    it('calculable dès que le coût livreur est connu, même sans frais PSP', () => {
      const c = contribution(
        { ...TYPICAL, delivery: FROZEN },
        COMMISSION,
        NO_FEES,
      );

      // revenu 320 + 400 + 1 000 = 1 720 ; coûts 350 → 1 370
      expect(c.revenue).toBe(1720);
      expect(c.contributionMarginBeforeProviderFees).toBe(1370);
    });

    it('la contribution STRICTE reste `null` : les frais PSP manquent toujours', () => {
      const c = contribution(
        { ...TYPICAL, delivery: FROZEN },
        COMMISSION,
        NO_FEES,
      );

      expect(c.contributionMargin).toBeNull();
      expect(c.missingInputs).toEqual(['collectionFee', 'payoutFee']);
    });

    it('inconnue elle aussi quand le coût livreur manque', () => {
      // Sans coût livreur, retirer les frais PSP ne suffit pas : il reste un
      // trou. Rendre un nombre ici serait le mensonge que tout ce calcul évite.
      const c = contribution(
        { ...TYPICAL, delivery: null },
        COMMISSION,
        NO_FEES,
      );

      expect(c.contributionMarginBeforeProviderFees).toBeNull();
    });

    it('les deux coïncident quand les frais PSP sont connus', () => {
      const c = contribution(
        { ...TYPICAL, delivery: FROZEN },
        COMMISSION,
        FEES,
      );

      expect(c.contributionMargin).toBe(1175); // 1 720 − 350 − 120 − 75
      expect(c.contributionMarginBeforeProviderFees).toBe(1370);
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
      // ⚠️ Ce test gardait auparavant l'ABSENCE de la clé `driverCost` : le
      // concept n'existait pas, donc ne rien exposer était la seule honnêteté.
      // Depuis le gel économique de la course (18/09/2026), le champ existe et
      // vaut `null` quand le coût est inconnu. L'intention est inchangée — rien
      // n'est inventé — mais elle s'exprime désormais sur la VALEUR.
      const result = contribution(TYPICAL, COMMISSION, FEES);

      expect(result.driverCost).toBeNull();
      // Et surtout pas 0 : ce serait « il n'a rien coûté » au lieu de
      // « on ne sait pas ».
      expect(result.driverCost).not.toBe(0);
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
