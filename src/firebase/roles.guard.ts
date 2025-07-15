/* eslint-disable prettier/prettier */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from 'src/prisma/prisma.service';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate{
    constructor(private reflector: Reflector, private prisma: PrismaService){}

    async canActivate(context: ExecutionContext): Promise<boolean>{
        const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if(!requiredRoles?.length) return true;

         const request = context.switchToHttp().getRequest();
    const firebaseUser = request.user;

    const user = await this.prisma.user.findUnique({
      where: { firebaseUid: firebaseUser.uid },
    });

    request.userRecord = user;

    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException('Accès refusé');
    }

    return true;

    }

}