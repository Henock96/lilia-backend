import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';

/**
 * Validation du DTO telle que la `ValidationPipe` globale l'applique
 * (`transform: true`, `whitelist: true`).
 */
async function run(payload: Record<string, unknown>) {
  const dto = plainToInstance(UpdatePlatformSettingsDto, payload);
  const errors = await validate(dto, { whitelist: true });
  return { dto, errors: errors.map((e) => e.property) };
}

describe('UpdatePlatformSettingsDto — canal de mise à jour', () => {
  describe('URL Android (UPD-002)', () => {
    it('accepte la fiche Play de Lilia Food', async () => {
      const { errors } = await run({
        updateUrlAndroid:
          'https://play.google.com/store/apps/details?id=com.dreesis.lilia.lilia_app',
      });
      expect(errors).toEqual([]);
    });

    it.each([
      'https://example.com/typo',
      'https://play.google.com/store/apps/details?id=com.lilia.food',
      'javascript:alert(1)',
    ])('refuse %s', async (url) => {
      expect((await run({ updateUrlAndroid: url })).errors).toContain(
        'updateUrlAndroid',
      );
    });
  });

  describe('URL iOS (UPD-002)', () => {
    it.each([
      'https://apps.apple.com/search?term=Lilia%20Food',
      'https://example.com/app/id1234567890',
      'itms-apps://evil.com/app/id1234567890',
    ])('refuse %s', async (url) => {
      expect((await run({ updateUrlIos: url })).errors).toContain(
        'updateUrlIos',
      );
    });
  });

  it('null efface une URL (seule façon de lever une redirection)', async () => {
    const { errors } = await run({
      updateUrlAndroid: null,
      updateUrlIos: null,
    });
    expect(errors).toEqual([]);
  });

  describe('messages blancs → null', () => {
    it.each(['', '   '])('maintenanceMessage %p devient null', async (m) => {
      const { dto, errors } = await run({ maintenanceMessage: m });
      expect(errors).toEqual([]);
      expect(dto.maintenanceMessage).toBeNull();
    });

    it('updateMessage vide devient null', async () => {
      const { dto } = await run({ updateMessage: '' });
      expect(dto.updateMessage).toBeNull();
    });

    it('un message réel est conservé tel quel', async () => {
      const { dto } = await run({ maintenanceMessage: 'Retour à 14 h' });
      expect(dto.maintenanceMessage).toBe('Retour à 14 h');
    });

    it('updateMessage de plus de 300 caractères est refusé', async () => {
      expect((await run({ updateMessage: 'x'.repeat(301) })).errors).toContain(
        'updateMessage',
      );
    });
  });

  describe('expectedUpdatedAt (SET-001)', () => {
    it('accepte un horodatage ISO', async () => {
      expect(
        (await run({ expectedUpdatedAt: '2026-09-22T10:00:00.000Z' })).errors,
      ).toEqual([]);
    });

    it('refuse une valeur qui n’est pas une date', async () => {
      expect((await run({ expectedUpdatedAt: 'hier' })).errors).toContain(
        'expectedUpdatedAt',
      );
    });
  });

  it('une version vide est refusée : effacer, c’est envoyer null', async () => {
    expect((await run({ minAppVersion: '' })).errors).toContain(
      'minAppVersion',
    );
  });
});
