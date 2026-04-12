/* eslint-disable prettier/prettier */
// cloudinary/cloudinary.controller.ts
import {
  Controller, MaxFileSizeValidator, ParseFilePipe,
  Post, UploadedFile, UseInterceptors, Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CloudinaryService, CloudinaryFolder } from './cloudinary.service';

@ApiTags('Upload')
@ApiBearerAuth()
@Controller('upload')
export class CloudinaryController {
  constructor(private readonly cloudinaryService: CloudinaryService) {}

  /**
   * Upload une image — utilisé par le frontend pour restaurants, produits, profils.
   * Max 5 MB. Retourne l'URL Cloudinary à stocker en DB.
   */
  @Post('image')
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
        validators: [new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 })], // 5 MB
      }),
    )
    file: Express.Multer.File,
    @Query('folder') folder: CloudinaryFolder = 'products',
  ) {
    const result = await this.cloudinaryService.uploadBuffer(file.buffer, folder);
    return {
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
    };
  }
}