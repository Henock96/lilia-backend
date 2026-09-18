import { DriverCompensationModel, DriverEmploymentType } from '@prisma/client';

import { computeDeliverySplit } from '../payments/money.util';

/**
 * Ce qu'il faut savoir d'un livreur pour calculer sa course.
 *
 * Volontairement une **forme minimale** et non `DriverProfile` : cette fonction
 * ne doit rien pouvoir lire d'autre. Lui passer l'entité entière inviterait à y
 * brancher un jour la plaque, les zones ou le statut — et à faire dépendre un
 * montant d'argent d'une donnée qui n'a rien d'économique.
 */
export interface DriverCompensationProfile {
  employmentType: DriverEmploymentType;
  compensationModel: DriverCompensationModel;
  /** Taux propre au livreur. `null` = taux plateforme de son type. */
  driverSharePercent: number | null;
}

/** Les deux taux plateforme. Ce sont des parts **du livreur**. */
export interface DriverShareSettings {
  driverSharePercentLilia: number;
  driverSharePercentIndependent: number;
}

/** Le snapshot économique d'une course, prêt à être figé. */
export interface DriverCompensation {
  employmentType: DriverEmploymentType;
  compensationModel: DriverCompensationModel;
  /** Assiette retenue — le tarif AVANT remise commerciale. */
  baseXaf: number;
  /** Taux appliqué, ou `null` quand aucun ne s'applique (modèle `SALARY`). */
  driverSharePercent: number | null;
  driverPayXaf: number;
  /** Résidu : `baseXaf − driverPayXaf`. Jamais un second calcul. */
  liliaShareXaf: number;
}

/**
 * **Point unique** de résolution de la rémunération d'une course.
 *
 * ## Un seul résolveur, un seul repli
 *
 * La commission vendeur a montré ce que coûtent deux résolveurs concurrents :
 * le checkout retombait sur `0`, le reversement sur le taux plateforme, et la
 * production a vécu des mois avec des commandes annonçant 0 % pendant que les
 * virements prélevaient 10 %. Toute lecture de taux passe donc par ici, et
 * nulle part ailleurs.
 *
 * ## Fonction pure, et c'est le sujet
 *
 * Aucune injection, aucun accès base : le profil et les réglages sont des
 * paramètres. Ses tests exercent donc le vrai code plutôt qu'un double, et le
 * jour où le calcul devra être rejoué (simulation, reprise, rapport), il n'y a
 * rien à instancier.
 *
 * ## Ce qu'elle rend, et ce qu'elle refuse
 *
 * `null` quand le livreur n'a pas de profil : son économie n'est pas
 * déterminable, l'appelant n'écrit alors aucun snapshot et le coût reste
 * `UNKNOWN`. Rendre `0` serait un mensonge favorable à la plateforme.
 *
 * ⚠️ Ne jamais transformer ce `null` en `0` en amont. C'est la règle que tout
 * le calcul de contribution applique déjà : un nombre absent qui dit pourquoi
 * vaut mieux qu'un nombre présent qui ment.
 */
export function computeDriverCompensation(input: {
  profile: DriverCompensationProfile | null;
  settings: DriverShareSettings;
  baseXaf: number;
}): DriverCompensation | null {
  const { profile, settings, baseXaf } = input;

  if (!profile) return null;

  // Le modèle décide AVANT le taux : au salaire, aucun taux ne s'applique, et
  // en afficher un serait faux. `driverSharePercent` reste donc `null` — ce
  // n'est pas un trou, c'est « sans objet ».
  if (profile.compensationModel === DriverCompensationModel.SALARY) {
    const base = computeDeliverySplit({ baseXaf, driverSharePercent: 0 });
    return {
      employmentType: profile.employmentType,
      compensationModel: profile.compensationModel,
      baseXaf: base.baseXaf,
      driverSharePercent: null,
      driverPayXaf: 0,
      // Lilia garde la totalité de la course. Le salaire est un coût de
      // PÉRIODE : il n'a rien à faire dans l'économie d'une commande.
      liliaShareXaf: base.baseXaf,
    };
  }

  // `??` et non `||` : un livreur à 0 % a bien un taux, et il vaut 0. Le
  // remplacer par le taux plateforme le paierait contre son contrat.
  const platformShare =
    profile.employmentType === DriverEmploymentType.INDEPENDENT
      ? settings.driverSharePercentIndependent
      : settings.driverSharePercentLilia;
  const sharePercent = profile.driverSharePercent ?? platformShare;

  const split = computeDeliverySplit({
    baseXaf,
    driverSharePercent: sharePercent,
  });

  return {
    employmentType: profile.employmentType,
    compensationModel: profile.compensationModel,
    baseXaf: split.baseXaf,
    // Le taux réellement appliqué, pas celui demandé : c'est lui qu'on fige.
    driverSharePercent: split.driverSharePercent,
    driverPayXaf: split.driverPayXaf,
    liliaShareXaf: split.liliaShareXaf,
  };
}
