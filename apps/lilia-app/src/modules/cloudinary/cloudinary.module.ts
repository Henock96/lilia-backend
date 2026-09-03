import { Module } from '@nestjs/common';
import { CloudinaryController } from './cloudinary.controller';
import { CloudinaryService } from './cloudinary.service';

/**
 * ⚠️ `CloudinaryController` doit rester déclaré ici : sans lui,
 * `POST /upload/image` n'est jamais monté et les fronts reçoivent le 404
 * d'Express (« Cannot POST /upload/image?folder=... »). Le contrôleur a
 * existé sans être enregistré, donc invisible pour `tsc`, le lint et les
 * tests — c'est `upload-route.spec.ts` qui garde la route montée.
 *
 * Ce module reste importable par `PhotosCommonModule` : il n'est **pas** dans
 * le graphe du worker (cf. `orders-core.module.ts`), le controller ne s'y
 * monte donc pas sans guards.
 */
@Module({
  controllers: [CloudinaryController],
  providers: [CloudinaryService],
  exports: [CloudinaryService],
})
export class CloudinaryModule {}
