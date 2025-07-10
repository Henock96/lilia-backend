import { Module } from '@nestjs/common';
import { UserService } from './users.service';
import { AuthController } from './users.controller';

@Module({
  providers: [UserService],
  controllers: [AuthController],
})
export class UsersModule {}
