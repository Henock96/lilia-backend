import { Module } from '@nestjs/common';
import { MenuImagesController } from './menu-images.controller';
import { MenuImagesService } from './menu-images.service';
import { PhotosCommonModule } from '../photos-common/photos-common.module';

@Module({
  imports: [PhotosCommonModule],
  controllers: [MenuImagesController],
  providers: [MenuImagesService],
})
export class MenuImagesModule {}
