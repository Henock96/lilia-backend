import { Module } from '@nestjs/common';
import { UserService } from './users.service';

@Module({
  providers: [UserService],
  controllers: [],
})
export class UsersModule {}
