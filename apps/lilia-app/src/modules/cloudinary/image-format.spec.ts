import { readFileSync } from 'fs';
import { join } from 'path';
import { Writable } from 'stream';
import { v2 as cloudinary } from 'cloudinary';

import { ACCEPTED_IMAGE_TYPES, isHeif } from './image-format';
import { CloudinaryController } from './cloudinary.controller';
import { CloudinaryService } from './cloudinary.service';

/**
 * Photos d'iPhone (HEIC/HEIF) sur `POST /upload/image`.
 *
 * Refusées jusqu'ici par `FileTypeValidator` (« current file type is
 * image/heic »), alors que c'est le format natif de l'appareil de la plupart
 * des vendeurs. Acceptées désormais, et CONVERTIES en JPG : Chrome, Firefox
 * et les WebView Android n'affichent pas le HEIC.
 *
 * Les fixtures sont de vrais fichiers (`sips` macOS). `FileTypeValidator` lui-
 * même ne tourne pas sous Jest (paquet `file-type` ESM, cf.
 * `cloudinary-upload-limits.spec.ts`) : on teste ici la liste qu'on lui donne,
 * et la détection qui décide de la conversion.
 */
const fixture = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', name));

describe('Formats d’image acceptés', () => {
  it.each([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
  ])('%s accepté', (mime) =>
    expect(ACCEPTED_IMAGE_TYPES.test(mime)).toBe(true),
  );

  it.each([
    'image/avif',
    'image/svg+xml',
    'image/gif',
    'text/html',
    'application/pdf',
  ])('%s refusé', (mime) =>
    expect(ACCEPTED_IMAGE_TYPES.test(mime)).toBe(false),
  );
});

describe('isHeif — ce qui décide la conversion en JPG', () => {
  it('un vrai HEIC d’appareil Apple', () => {
    expect(isHeif(fixture('photo.heic'))).toBe(true);
  });

  it.each(['photo.jpg', 'photo.png'])('%s n’est pas converti', (name) => {
    expect(isHeif(fixture(name))).toBe(false);
  });

  /** Même conteneur que HEIF (`mif1`), autre codec : pas d'amalgame. */
  it('un AVIF n’est pas un HEIF', () => {
    const avif = Buffer.alloc(32);
    avif.writeUInt32BE(28, 0);
    avif.write('ftypavif', 4, 'latin1');
    avif.write('mif1miafavif', 16, 'latin1');
    expect(isHeif(avif)).toBe(false);
  });

  it('un fichier trop court ou sans boîte ftyp', () => {
    expect(isHeif(Buffer.from('ftyp'))).toBe(false);
    expect(isHeif(Buffer.alloc(64))).toBe(false);
  });
});

describe('POST /upload/image — un HEIC est stocké en JPG', () => {
  const uploadBuffer = jest.fn().mockResolvedValue({
    secure_url:
      'https://res.cloudinary.com/x/image/upload/v1/lilia-food/products/a.jpg',
    public_id: 'lilia-food/products/a',
    width: 32,
    height: 32,
  });
  const controller = new CloudinaryController({ uploadBuffer } as never);
  const admin = { role: 'ADMIN' } as never;
  const file = (name: string) => ({ buffer: fixture(name) }) as never;

  beforeEach(() => uploadBuffer.mockClear());

  it('HEIC → conversion demandée', async () => {
    await controller.uploadImage(
      file('photo.heic'),
      { folder: 'products' } as never,
      admin,
    );
    expect(uploadBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'products',
      undefined,
      {
        convertTo: 'jpg',
      },
    );
  });

  it('PNG → format d’origine conservé (transparence d’un logo)', async () => {
    await controller.uploadImage(
      file('photo.png'),
      { folder: 'restaurants' } as never,
      admin,
    );
    expect(uploadBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'restaurants',
      undefined,
      {
        convertTo: undefined,
      },
    );
  });
});

describe('CloudinaryService.uploadBuffer — paramètre `format` transmis au SDK', () => {
  const conf = {
    get: (k: string) =>
      ({
        CLOUDINARY_CLOUD_NAME: 'demo',
        CLOUDINARY_API_KEY: '123',
        CLOUDINARY_API_SECRET: 's',
      })[k],
  } as never;

  it.each([
    [{ convertTo: 'jpg' as const }, 'jpg'],
    [{}, undefined],
  ])('%j → format %s', async (options, format) => {
    let params: Record<string, unknown> = {};
    const spy = jest
      .spyOn(cloudinary.uploader, 'upload_stream')
      .mockImplementation(((
        p: Record<string, unknown>,
        cb: (e: unknown, r: unknown) => void,
      ) => {
        params = p;
        cb(null, { secure_url: 'u' });
        return new Writable({ write: (_c, _e, next) => next() });
      }) as never);
    await new CloudinaryService(conf).uploadBuffer(
      Buffer.from('x'),
      'products',
      undefined,
      options,
    );
    expect(params.folder).toBe('lilia-food/products');
    expect(params.format).toBe(format);
    spy.mockRestore();
  });
});
