import { DriverCompensationModel, DriverEmploymentType } from '@prisma/client';

import { computeDriverCompensation } from './driver-compensation';

/**
 * Résolution de la rémunération d'une course — **le seul endroit** où l'on
 * décide « quel taux s'applique à ce livreur ? ».
 *
 * ## Pourquoi un résolveur unique, et pourquoi c'est écrit en gras partout
 *
 * Le système portait déjà cette notion en double pour la commission vendeur :
 * le checkout retombait sur `0`, le reversement sur le taux plateforme. Les
 * deux replis se contredisaient, et le résultat a tenu des mois en production —
 * les commandes disaient 0 %, les virements prélevaient 10 %.
 *
 * On ne refait pas ça pour le livreur. Cette fonction est **pure** : aucune
 * injection, aucun accès base. Elle prend le profil et les réglages, elle rend
 * la décision. Tout appelant passe par elle.
 *
 * ## Ce qu'elle refuse de faire
 *
 * Rendre un montant quand elle ne sait pas. Un livreur sans profil n'a pas
 * d'économie déterminable : elle rend `null`, et l'appelant n'écrit aucun
 * snapshot. Le coût restera `UNKNOWN`, ce qui est la vérité — et non `0`, qui
 * serait un mensonge favorable.
 */

const SETTINGS = {
  driverSharePercentLilia: 35,
  driverSharePercentIndependent: 65,
};

const profile = (
  overrides: Partial<{
    employmentType: DriverEmploymentType;
    compensationModel: DriverCompensationModel;
    driverSharePercent: number | null;
  }> = {},
) => ({
  employmentType: DriverEmploymentType.LILIA,
  compensationModel: DriverCompensationModel.PER_DELIVERY,
  driverSharePercent: null,
  ...overrides,
});

describe('computeDriverCompensation', () => {
  describe('le taux par défaut dépend du type de livreur', () => {
    it('livreur Lilia sans taux propre → 35 %, soit 350 sur 1 000', () => {
      const c = computeDriverCompensation({
        profile: profile(),
        settings: SETTINGS,
        baseXaf: 1000,
      });

      expect(c).toMatchObject({
        employmentType: DriverEmploymentType.LILIA,
        driverSharePercent: 35,
        driverPayXaf: 350,
        liliaShareXaf: 650,
      });
    });

    it('livreur indépendant sans taux propre → 65 %, soit 650 sur 1 000', () => {
      const c = computeDriverCompensation({
        profile: profile({
          employmentType: DriverEmploymentType.INDEPENDENT,
        }),
        settings: SETTINGS,
        baseXaf: 1000,
      });

      expect(c).toMatchObject({
        employmentType: DriverEmploymentType.INDEPENDENT,
        driverSharePercent: 65,
        driverPayXaf: 650,
        liliaShareXaf: 350,
      });
    });

    it('le taux propre au livreur prime sur celui de la plateforme', () => {
      const c = computeDriverCompensation({
        profile: profile({ driverSharePercent: 50 }),
        settings: SETTINGS,
        baseXaf: 1000,
      });

      expect(c).toMatchObject({ driverSharePercent: 50, driverPayXaf: 500 });
    });

    it('un taux propre à 0 % reste 0 % — ce n’est pas une absence de taux', () => {
      // Le piège `||` contre `??`. Un livreur à 0 % a bien un taux : il vaut 0.
      // Retomber sur 35 % le paierait contre son contrat.
      const c = computeDriverCompensation({
        profile: profile({ driverSharePercent: 0 }),
        settings: SETTINGS,
        baseXaf: 1000,
      });

      expect(c).toMatchObject({
        driverSharePercent: 0,
        driverPayXaf: 0,
        liliaShareXaf: 1000,
      });
    });
  });

  describe('le modèle de rémunération décide si la part s’applique', () => {
    it('SALARY → aucune part par course, et c’est un zéro CONNU', () => {
      const c = computeDriverCompensation({
        profile: profile({
          compensationModel: DriverCompensationModel.SALARY,
        }),
        settings: SETTINGS,
        baseXaf: 1000,
      });

      expect(c).toMatchObject({
        compensationModel: DriverCompensationModel.SALARY,
        // `null` et non 35 : aucun taux ne s'applique, en afficher un mentirait.
        driverSharePercent: null,
        driverPayXaf: 0,
        // Lilia garde la totalité de la course ; le salaire est un coût de
        // PÉRIODE, il n'appartient pas à cette commande.
        liliaShareXaf: 1000,
      });
    });

    it('SALARY_PLUS_PER_DELIVERY → la part s’applique comme en PER_DELIVERY', () => {
      const c = computeDriverCompensation({
        profile: profile({
          compensationModel: DriverCompensationModel.SALARY_PLUS_PER_DELIVERY,
        }),
        settings: SETTINGS,
        baseXaf: 1000,
      });

      expect(c).toMatchObject({ driverSharePercent: 35, driverPayXaf: 350 });
    });

    it('le modèle est toujours rendu — c’est lui qui rend un 0 lisible', () => {
      const salarie = computeDriverCompensation({
        profile: profile({
          compensationModel: DriverCompensationModel.SALARY,
        }),
        settings: SETTINGS,
        baseXaf: 1000,
      });
      const course = computeDriverCompensation({
        profile: profile({ driverSharePercent: 0 }),
        settings: SETTINGS,
        baseXaf: 1000,
      });

      // Deux `driverPayXaf: 0` de sens opposés. Sans le modèle, ils seraient
      // indistinguables — et l'un des deux serait une anomalie invisible.
      expect(salarie!.driverPayXaf).toBe(0);
      expect(course!.driverPayXaf).toBe(0);
      expect(salarie!.compensationModel).not.toBe(course!.compensationModel);
    });
  });

  describe('ce qu’elle refuse de deviner', () => {
    it('livreur sans profil → null, jamais un montant', () => {
      // Le coût reste UNKNOWN, et l'appelant n'écrira aucun snapshot. Rendre 0
      // transformerait « on ne sait pas » en « il n'a rien coûté ».
      expect(
        computeDriverCompensation({
          profile: null,
          settings: SETTINGS,
          baseXaf: 1000,
        }),
      ).toBeNull();
    });
  });

  describe('les cas limites de l’assiette', () => {
    it('tarif de livraison nul → snapshot valide à 0, pas d’absence de snapshot', () => {
      // Un vendeur peut poser `fixedDeliveryFee = 0`. Le livreur ne touche rien,
      // mais on SAIT qu'il ne touche rien : la contribution reste calculable.
      const c = computeDriverCompensation({
        profile: profile(),
        settings: SETTINGS,
        baseXaf: 0,
      });

      expect(c).toMatchObject({
        baseXaf: 0,
        driverPayXaf: 0,
        liliaShareXaf: 0,
      });
      expect(c).not.toBeNull();
    });

    it('l’invariant de somme tient quel que soit le modèle', () => {
      const models = [
        DriverCompensationModel.SALARY,
        DriverCompensationModel.PER_DELIVERY,
        DriverCompensationModel.SALARY_PLUS_PER_DELIVERY,
      ];
      const types = [
        DriverEmploymentType.LILIA,
        DriverEmploymentType.INDEPENDENT,
      ];

      for (const compensationModel of models) {
        for (const employmentType of types) {
          for (const baseXaf of [0, 1, 333, 1000, 12_345]) {
            const c = computeDriverCompensation({
              profile: profile({ compensationModel, employmentType }),
              settings: SETTINGS,
              baseXaf,
            })!;
            expect(c.driverPayXaf + c.liliaShareXaf).toBe(baseXaf);
          }
        }
      }
    });
  });
});
