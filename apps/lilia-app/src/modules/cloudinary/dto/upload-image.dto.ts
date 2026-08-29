import { IsIn, IsOptional } from 'class-validator';
import { CLOUDINARY_FOLDERS, CloudinaryFolder } from '../cloudinary.service';

/**
 * Query de `POST /upload/image` (fix H4 — audit du 28/08/2026).
 *
 * `@Query('folder') folder: CloudinaryFolder` ne validait **rien** : le type
 * TypeScript disparaît au runtime, et la valeur était concaténée telle quelle
 * dans `lilia-food/${folder}` — n'importe qui pouvait créer une arborescence
 * arbitraire dans le compte Cloudinary.
 */
export class UploadImageQueryDto {
  @IsOptional()
  @IsIn(CLOUDINARY_FOLDERS, {
    message: `folder doit valoir : ${CLOUDINARY_FOLDERS.join(', ')}`,
  })
  folder?: CloudinaryFolder;
}
