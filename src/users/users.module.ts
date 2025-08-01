import { Module } from '@nestjs/common';
import { UserService } from './users.service';
import { AuthController } from './users.controller';

@Module({
  providers: [UserService],
  controllers: [AuthController],
  exports: [UserService], // Exporter le service pour que d'autres modules puissent l'injecter
})
export class UsersModule {}
