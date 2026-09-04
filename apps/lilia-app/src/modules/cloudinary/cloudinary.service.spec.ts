import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';

/**
 * Comportement du service quand le stockage d'images n'est pas configuré.
 *
 * Constaté en production le 4 septembre 2026 : un vendeur ne pouvait pas
 * ajouter son logo, et le journal montrait
 *
 *   POST /upload/image?folder=restaurants → 500
 *   Error: Must supply api_key
 *       at CloudinaryService.uploadBuffer
 *
 * L'erreur venait de l'intérieur du SDK, remontait en 500 **non gérée**, et
 * n'indiquait à personne qu'il s'agissait de trois variables d'environnement
 * absentes sur le service. L'application mobile affichait « erreur serveur ».
 *
 * Les trois variables restent `optional()` dans la validation Joi, et c'est
 * délibéré : une plateforme sans envoi d'images continue de prendre des
 * commandes. Faire échouer le démarrage couperait tout pour une fonction
 * accessoire. Ce qu'on exige, c'est que l'absence soit **dite** — au
 * démarrage, et à l'appel.
 */
const conf = (values: Record<string, string | undefined>) =>
  ({ get: (k: string) => values[k] }) as never;

const COMPLET = {
  CLOUDINARY_CLOUD_NAME: 'dun9ev7pw',
  CLOUDINARY_API_KEY: '123456789012345',
  CLOUDINARY_API_SECRET: 'secret-de-test',
};

describe('CloudinaryService — configuration absente', () => {
  it('se déclare prêt quand les trois identifiants sont là', () => {
    expect(new CloudinaryService(conf(COMPLET)).isReady()).toBe(true);
  });

  it.each([
    ['CLOUDINARY_CLOUD_NAME'],
    ['CLOUDINARY_API_KEY'],
    ['CLOUDINARY_API_SECRET'],
  ])('n’est pas prêt si %s manque', (absent) => {
    const service = new CloudinaryService(
      conf({ ...COMPLET, [absent]: undefined }),
    );
    expect(service.isReady()).toBe(false);
  });

  it('traite une chaîne vide comme une absence', () => {
    // Une variable définie mais vide sur Render est le cas le plus courant.
    const service = new CloudinaryService(
      conf({ ...COMPLET, CLOUDINARY_API_KEY: '' }),
    );
    expect(service.isReady()).toBe(false);
  });

  it('refuse l’envoi en 503 avec un code métier, pas en 500 opaque', async () => {
    const service = new CloudinaryService(conf({}));
    await expect(
      service.uploadBuffer(Buffer.from('img'), 'restaurants'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('le refus nomme la cause sans exposer la configuration au client', async () => {
    const service = new CloudinaryService(conf({}));
    await service.uploadBuffer(Buffer.from('img'), 'restaurants').catch((e) => {
      const body = (e as ServiceUnavailableException).getResponse() as {
        message: string;
        code: string;
      };
      expect(body.code).toBe('IMAGE_STORAGE_NOT_CONFIGURED');
      expect(body.message).toMatch(/indisponible/i);
      // Le client n'a pas à connaître le nom de nos variables d'environnement.
      expect(body.message).not.toMatch(/CLOUDINARY_/);
    });
    expect.assertions(3);
  });

  it('refuse aussi la suppression — même raison', async () => {
    const service = new CloudinaryService(conf({}));
    await expect(service.deleteImage('lilia-food/x')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('journalise l’anomalie au démarrage, en nommant ce qui manque', () => {
    // C'est ce message qui aurait évité de découvrir le problème par un 500
    // sur le téléphone d'un vendeur.
    const errors: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((msg: unknown) => {
        errors.push(String(msg));
      });

    new CloudinaryService(conf({ CLOUDINARY_CLOUD_NAME: 'dun9ev7pw' }));

    const journal = errors.join(' ');
    expect(journal).toContain('CLOUDINARY_API_KEY');
    expect(journal).toContain('CLOUDINARY_API_SECRET');
    // Le nom du cloud est présent : il ne doit pas être listé comme manquant.
    expect(journal).not.toContain('CLOUDINARY_CLOUD_NAME');

    spy.mockRestore();
  });
});
