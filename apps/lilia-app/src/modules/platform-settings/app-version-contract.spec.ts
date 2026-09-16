import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import {
  APP_VERSION_PATTERN,
  UpdatePlatformSettingsDto,
} from './dto/update-platform-settings.dto';

/**
 * Contrat de version entre le serveur et les applications mobiles.
 *
 * `minAppVersion` est le seul réglage du back-office capable d'**empêcher un
 * client de commander** : en dessous du seuil, l'application se bloque et
 * exige une mise à jour. Deux exigences en découlent, et ces tests les tiennent
 * toutes les deux.
 *
 * 1. **Le serveur refuse ce que les clients ne savent pas lire.** Les apps
 *    parsent strictement (`AppVersion.tryParse`) et ignorent une valeur mal
 *    formée. Si le serveur l'acceptait, l'administrateur croirait avoir posé
 *    un seuil qui n'existe nulle part — panne silencieuse dans le sens le plus
 *    dangereux : celui où on croit être protégé.
 * 2. **Une faute de frappe ne doit pas devenir un seuil valide.** « 1.2 » ne
 *    doit pas être promu en « 1.2.0 » : un opérateur qui voulait taper
 *    « 1.2.0 » et s'est arrêté trop tôt bloquerait tout le parc antérieur à
 *    la 1.2 sans s'en apercevoir.
 */
async function errorsFor(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(UpdatePlatformSettingsDto, payload);
  const errors = await validate(dto, { whitelist: true });
  return errors.map((e) => e.property);
}

describe('Contrat de version applicative', () => {
  describe('APP_VERSION_PATTERN', () => {
    it.each(['1.0.0', '1.2.7', '1.2.7+32', '10.20.30', '0.0.1+1'])(
      'accepte %s',
      (value) => {
        expect(APP_VERSION_PATTERN.test(value)).toBe(true);
      },
    );

    it.each([
      '1.2', // tronquée — l'erreur de frappe la plus probable
      '1', //
      '1.2.x', //
      'v1.2.7', // le « v » se retire côté client, pas côté saisie
      '1.2.7-beta', // pré-version : les stores n'en distribuent pas
      '1.2.7+', // build annoncé puis absent
      '1.2.7.4', // quatre segments
      ' 1.2.7', // espace : invisible à la relecture
      '',
    ])('refuse %p', (value) => {
      expect(APP_VERSION_PATTERN.test(value)).toBe(false);
    });
  });

  describe('UpdatePlatformSettingsDto', () => {
    it('accepte des seuils bien formés', async () => {
      expect(
        await errorsFor({
          minAppVersion: '1.2.0',
          latestAppVersion: '1.3.0+41',
        }),
      ).toEqual([]);
    });

    it('rejette un minAppVersion tronqué plutôt que de le compléter', async () => {
      expect(await errorsFor({ minAppVersion: '1.2' })).toContain(
        'minAppVersion',
      );
    });

    it('rejette un latestAppVersion mal formé', async () => {
      expect(await errorsFor({ latestAppVersion: '2.0' })).toContain(
        'latestAppVersion',
      );
    });

    it('laisse omettre les champs : null signifie « aucune contrainte »', async () => {
      // C'est ce qui rend la migration sans effet tant qu'un administrateur
      // n'a rien renseigné — le parc installé ne voit aucune différence.
      expect(await errorsFor({ serviceFeePercent: 8 })).toEqual([]);
    });

    it('refuse une URL de store sans protocole', async () => {
      // `play.google.com/...` sans schéma n'ouvre rien sur le téléphone.
      expect(
        await errorsFor({ updateUrlAndroid: 'play.google.com/store/apps' }),
      ).toContain('updateUrlAndroid');
    });

    it('accepte les schémas de store natifs', async () => {
      expect(
        await errorsFor({
          updateUrlAndroid:
            'https://play.google.com/store/apps/details?id=com.dreesis.lilia.lilia_app',
          updateUrlIos: 'https://apps.apple.com/app/lilia-food/id6740000000',
        }),
      ).toEqual([]);
    });
  });
});
