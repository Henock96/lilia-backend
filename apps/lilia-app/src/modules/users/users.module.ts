import { Module } from '@nestjs/common';
import { UserService } from './users.service';
import { UsersController } from './users.controller';

@Module({
  providers: [UserService],
  controllers: [UsersController],
  exports: [UserService], // Exporter le service pour que d'autres modules puissent l'injecter
})
export class UsersModule {}
