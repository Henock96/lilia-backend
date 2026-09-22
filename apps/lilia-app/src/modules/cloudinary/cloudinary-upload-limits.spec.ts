import { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { CloudinaryController } from './cloudinary.controller';
import { CloudinaryService } from './cloudinary.service';
import { HttpExceptionFilter } from '../../common/exception-filters/http-exception.filter';

/** Signature PNG — `FileTypeValidator` lit ces octets, pas l'en-tête déclaré. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(bytes: number): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(bytes - PNG_MAGIC.length, 0)]);
}

/**
 * Bornes d'envoi de `POST /upload/image`.
 *
 * ⚠️ `MaxFileSizeValidator` est un `ParseFilePipe` : il s'exécute **après** que
 * multer a entièrement bufferisé le fichier en mémoire (`memoryStorage` est le
 * défaut de `FileInterceptor`). Sans `limits`, un compte authentifié pouvait
 * donc faire allouer un corps arbitrairement gros — dix fois par minute, ce que
 * `@Throttle` autorise. Sur une instance Render, la RAM cède avant le quota.
 *
 * La borne qui protège est celle de **multer**, qui coupe le flux ; le
 * validateur reste la seconde barrière.
 *
 * ⚠️ **Ce fichier ne teste pas la validation de TYPE**, et c'est délibéré :
 * `FileTypeValidator` de `@nestjs/common` v11 inspecte le nombre magique via
 * `file-type`, un paquet **ESM**. Sous Jest sans
 * `NODE_OPTIONS=--experimental-vm-modules`, l'import dynamique échoue et le
 * validateur rejette *tout* (fail-closed — le bon sens, mais inobservable ici).
 * Un test de type passerait donc pour la mauvaise raison. La vérification du
 * contenu est couverte en exécution réelle, pas ici.
 */
describe('POST /upload/image — bornes d’envoi', () => {
  let app: INestApplication;
  const uploadBuffer = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CloudinaryController],
      providers: [
        { provide: CloudinaryService, useValue: { uploadBuffer } },
        // Le filtre global fait partie du contrat : c'est lui qui traduit
        // l'erreur de multer en code HTTP.
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Les guards globaux vivent dans `AuthModule`, absent de ce graphe : on
    // pose l'utilisateur à la main pour tester les seules bornes d'envoi.
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'u-admin', role: 'ADMIN' };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => uploadBuffer.mockReset());

  function upload(file: Buffer, filename = 'image.png') {
    return request(app.getHttpServer())
      .post('/upload/image?folder=products')
      .attach('file', file, { filename, contentType: 'image/png' });
  }

  it('refuse un fichier de 6 Mo en 413, sans appeler le prestataire', async () => {
    const res = await upload(png(6 * 1024 * 1024));

    expect(res.status).toBe(413);
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('ne présente jamais un envoi hors limite comme une panne serveur', async () => {
    const res = await upload(png(6 * 1024 * 1024));

    // Un 5xx déclencherait le rejeu automatique du `RetryInterceptor` côté
    // Flutter : le même fichier repartirait trois fois.
    expect(res.status).toBeLessThan(500);
  });

  it('ne refuse pas un fichier d’un kilo-octet pour sa taille', async () => {
    const res = await upload(png(1024));

    // Garde contre une limite posée trop bas : le refus, s'il arrive, ne doit
    // jamais venir de la taille.
    expect(res.status).not.toBe(413);
  });

  it('refuse un second fichier dans le même envoi, en 4xx', async () => {
    const res = await request(app.getHttpServer())
      .post('/upload/image?folder=products')
      .attach('file', png(1024), {
        filename: 'a.png',
        contentType: 'image/png',
      })
      .attach('file', png(1024), {
        filename: 'b.png',
        contentType: 'image/png',
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    // Un envoi malformé est une erreur de client, pas une panne — sans quoi il
    // serait rejoué trois fois lui aussi.
    expect(res.status).toBeLessThan(500);
    expect(uploadBuffer).not.toHaveBeenCalled();
  });
});
