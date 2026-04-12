/* eslint-disable prettier/prettier */
// cloudinary/cloudinary.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

export type CloudinaryFolder =
  | 'restaurants'
  | 'products'
  | 'menus'
  | 'users'
  | 'banners';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(private readonly config: ConfigService) {
    cloudinary.config({
      cloud_name: this.config.get('CLOUDINARY_CLOUD_NAME'),
      api_key: this.config.get('CLOUDINARY_API_KEY'),
      api_secret: this.config.get('CLOUDINARY_API_SECRET'),
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