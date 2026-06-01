import { Module } from '@nestjs/common';
import { VendorPhotosController } from './vendor-photos.controller';
import { VendorPhotosService } from './vendor-photos.service';
import { PhotosCommonModule } from '../photos-common/photos-common.module';

@Module({
  imports: [PhotosCommonModule],
  controllers: [VendorPhotosController],
  providers: [VendorPhotosService],
})
export class VendorPhotosModule {}
