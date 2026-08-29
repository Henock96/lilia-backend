/* eslint-disable prettier/prettier */
// cloudinary/cloudinary.controller.ts
import {
  Controller, FileTypeValidator, ForbiddenException, MaxFileSizeValidator, ParseFilePipe,
  Post, UploadedFile, UseInterceptors, Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';

import { CloudinaryService, CloudinaryFolder } from './cloudinary.service';
import { UploadImageQueryDto } from './dto/upload-image.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

/** Dossiers qu'un compte peut viser selon son rôle (fix H4). */
const ALLOWED_FOLDERS_BY_ROLE: Record<string, CloudinaryFolder[]> = {
  // Un client ne publie que sa propre photo de profil : il n'a aucune raison
  // d'écrire dans le catalogue, et 5 Mo par requête sur le quota Cloudinary de
  // la plateforme est un abus facile.
  CLIENT: ['users'],
  LIVREUR: ['users'],
  RESTAURATEUR: ['users', 'restaurants', 'products', 'menus'],
  ADMIN: ['users', 'restaurants', 'products', 'menus', 'banners'],
};

@ApiTags('Upload')
@ApiBearerAuth()
@Controller('upload')
export class CloudinaryController {
  constructor(private readonly cloudinaryService: CloudinaryService) {}

  /**
   * Upload une image — utilisé par le frontend pour restaurants, produits, profils.
   * Max 5 MB. Retourne l'URL Cloudinary à stocker en DB.
   *
   * SÉCURITÉ (fix H4, audit du 28/08/2026) : la route n'avait **aucun**
   * `@Roles()` et le `folder` n'était pas validé. Trois garde-fous ajoutés :
   * rôle requis, dossier dans une liste blanche vérifiée au runtime, et
   * périmètre de dossiers dérivé du rôle de l'appelant. Plus un throttle
   * serré : chaque appel coûte de la bande passante et du quota Cloudinary.
   */
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 10, ttl: 60000 } })
  @Post('image')
  @Roles('CLIENT', 'LIVREUR', 'RESTAURATEUR', 'ADMIN')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload une image vers Cloudinary' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        folder: {
          type: 'string',
          enum: ['restaurants', 'products', 'menus', 'users', 'banners'],
        },
      },
    },
  })
  async uploadImage(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }), // 5 MB
          // N'accepte que des images — empêche l'hébergement de fichiers
          // arbitraires (HTML/SVG/binaires) sur le compte Cloudinary.
          // ⚠️ Ce validateur lit le mimetype DÉCLARÉ par le client : le
          // rempart réel reste `resource_type: 'image'` côté Cloudinary.
          new FileTypeValidator({ fileType: /^image\/(jpeg|jpg|png|webp)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Query() query: UploadImageQueryDto,
    @CurrentUser() user: User,
  ) {
    const folder: CloudinaryFolder = query.folder ?? 'products';
    const allowed = ALLOWED_FOLDERS_BY_ROLE[user?.role] ?? ['users'];
    if (!allowed.includes(folder)) {
      throw new ForbiddenException(
        `Votre compte ne peut pas déposer d'image dans « ${folder} ».`,
      );
    }

    const result = await this.cloudinaryService.uploadBuffer(file.buffer, folder);
    return {
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
    };
  }
}
