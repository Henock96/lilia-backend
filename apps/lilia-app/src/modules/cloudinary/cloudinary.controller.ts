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

/**
 * Plafond de taille, en octets — **une seule fois**, pour que la borne multer
 * et le validateur ne puissent pas diverger.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

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
  /**
   * ⚠️ `limits` n'est pas un doublon du `MaxFileSizeValidator` ci-dessous.
   *
   * Le validateur est un `ParseFilePipe` : il s'exécute **après** que multer a
   * entièrement bufferisé le fichier en mémoire (`memoryStorage` est le défaut
   * de `FileInterceptor`). Il dit « trop gros » à un corps déjà alloué — ce qui
   * ne protège de rien. Un compte authentifié, quel que soit son rôle, pouvait
   * donc faire allouer dix corps arbitrairement gros par minute, ce que le
   * `@Throttle` ci-dessus autorise ; sur une instance Render, la RAM cède avant
   * le quota Cloudinary.
   *
   * `limits` coupe le flux à la limite : c'est la borne qui protège. Le
   * validateur reste la seconde barrière, et couvre le cas où ce décorateur
   * serait modifié sans lui.
   *
   * `files: 1` ferme la variante du même abus par multiplication des parties.
   */
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
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
          new MaxFileSizeValidator({ maxSize: MAX_UPLOAD_BYTES }),
          // N'accepte que des images — empêche l'hébergement de fichiers
          // arbitraires (HTML/SVG/binaires) sur le compte Cloudinary.
          //
          // ⚠️ Ce commentaire disait le contraire, et se trompait : depuis
          // `@nestjs/common` v11, `FileTypeValidator` inspecte le **nombre
          // magique** du contenu (paquet `file-type`), pas le mimetype déclaré
          // par le client. Il faut poser `skipMagicNumbersValidation` ou
          // `fallbackToMimetype` pour retrouver l'ancien comportement — ce
          // qu'on ne fait pas. Un exécutable renommé `.png` et annoncé
          // `image/png` est donc refusé ici, et pas seulement chez Cloudinary.
          //
          // Le corollaire est qu'un échec de chargement de `file-type` fait
          // rendre `false` : le contrôle est fail-closed, il refuse plutôt
          // qu'il ne laisse passer.
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
