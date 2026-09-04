/* eslint-disable prettier/prettier */
// cloudinary/cloudinary.service.ts
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

/**
 * Liste blanche des dossiers Cloudinary. Exportée comme valeur (et non plus
 * seulement comme type) pour être vérifiable au runtime par `@IsIn` — un type
 * TypeScript ne valide rien une fois compilé (fix H4).
 */
export const CLOUDINARY_FOLDERS = [
  'restaurants',
  'products',
  'menus',
  'users',
  'banners',
] as const;

export type CloudinaryFolder = (typeof CLOUDINARY_FOLDERS)[number];

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  /** Les trois identifiants sont-ils présents ? */
  private readonly configured: boolean;

  constructor(private readonly config: ConfigService) {
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET');

    this.configured = Boolean(cloudName && apiKey && apiSecret);

    if (this.configured) {
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
      });
    } else {
      // Visible au démarrage, et non à la première photo ajoutée par un
      // vendeur. Les trois variables sont `optional()` dans la validation Joi
      // — délibérément : une plateforme sans envoi d'images reste capable de
      // prendre des commandes, et faire échouer le boot couperait tout pour
      // une fonction accessoire.
      const missing = [
        !cloudName && 'CLOUDINARY_CLOUD_NAME',
        !apiKey && 'CLOUDINARY_API_KEY',
        !apiSecret && 'CLOUDINARY_API_SECRET',
      ].filter(Boolean);
      this.logger.error(
        `⚠️ Cloudinary non configuré (${missing.join(', ')} manquant(e)s) — ` +
          'tout envoi de photo échouera en 503 tant que ces variables ne sont ' +
          'pas définies sur le service.',
      );
    }
  }

  /**
   * Le service peut-il réellement envoyer une image ?
   *
   * Même convention qu'`EmailService.isReady()`. Un consommateur qui veut
   * dégrader proprement l'interroge plutôt que de tenter et d'échouer.
   */
  isReady(): boolean {
    return this.configured;
  }

  /**
   * Refuse tôt, et en disant quoi corriger.
   *
   * Sans cette garde, le SDK Cloudinary lève `Must supply api_key` depuis
   * l'intérieur d'un `upload_stream` : l'erreur remonte en **500 non gérée**,
   * l'application mobile affiche « erreur serveur », et rien n'indique qu'il
   * s'agit d'une variable d'environnement absente. Constaté en production le
   * 4 septembre 2026 sur `POST /upload/image?folder=restaurants` — un vendeur
   * ne pouvait pas ajouter son logo.
   */
  private assertConfigured(): void {
    if (this.configured) return;
    throw new ServiceUnavailableException({
      message:
        'L’envoi d’images est indisponible : le service de stockage n’est pas ' +
        'configuré. Contactez un administrateur.',
      code: 'IMAGE_STORAGE_NOT_CONFIGURED',
    });
  }

  /**
   * Upload un fichier Buffer vers Cloudinary.
   * Utilisé après multer qui parse le multipart/form-data.
   */
  async uploadBuffer(
    buffer: Buffer,
    folder: CloudinaryFolder,
    fileName?: string,
  ): Promise<UploadApiResponse> {
    this.assertConfigured();
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `lilia-food/${folder}`,
          public_id: fileName,
          resource_type: 'image',
          transformation: [
            { width: 1200, height: 1200, crop: 'limit' }, // max dimensions
            { quality: 'auto:good' },                      // compression auto
            { fetch_format: 'auto' },                      // webp si supporté
          ],
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result!);
        },
      );

      Readable.from(buffer).pipe(stream);
    });
  }

  /**
   * Supprime une image par son public_id.
   */
  async deleteImage(publicId: string): Promise<void> {
    this.assertConfigured();
    await cloudinary.uploader.destroy(publicId);
    this.logger.log(`Image supprimée : ${publicId}`);
  }

  /**
   * Extrait le public_id depuis une URL Cloudinary.
   * Utile pour supprimer l'ancienne image quand on en upload une nouvelle.
   */
  extractPublicId(imageUrl: string): string | null {
    try {
      const match = imageUrl.match(/lilia-food\/.*?(?=\.\w+$)/);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  }
}