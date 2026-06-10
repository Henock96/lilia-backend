import { Module } from '@nestjs/common';
import { PhotosCommonService } from './photos-common.service';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';

@Module({
  imports: [CloudinaryModule],
  providers: [PhotosCommonService],
  exports: [PhotosCommonService],
})
export class PhotosCommonModule {}
