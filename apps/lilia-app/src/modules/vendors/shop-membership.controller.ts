import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminCapability, User } from '@prisma/client';
import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  INVITABLE_SHOP_ROLES,
  InvitableShopRole,
  ShopMembershipService,
} from './shop-membership.service';

export class AddShopMemberDto {
  @IsEmail({}, { message: 'E-mail invalide.' })
  @MaxLength(200)
  email!: string;

  @IsIn(INVITABLE_SHOP_ROLES as unknown as string[], {
    message: 'Rôle : MANAGER ou STAFF.',
  })
  role!: InvitableShopRole;
}

export class RevokeShopMemberDto {
  @IsString()
  @MinLength(5, { message: 'Motif obligatoire (5 caractères au moins).' })
  @MaxLength(500)
  reason!: string;
}

/**
 * Membres d'une boutique (durcissement lot 3, point 7).
 *
 * Propriétaire (permission `MEMBERS`) ou ADMIN. Pour l'ADMIN, ajouter ou
 * révoquer revient à attribuer un accès : capacité `USER_ROLES`.
 */
@ApiTags('Boutique — membres')
@ApiBearerAuth()
@Controller('vendors/:restaurantId/members')
@Roles('RESTAURATEUR', 'ADMIN')
export class ShopMembershipController {
  constructor(private readonly members: ShopMembershipService) {}

  @Get()
  @ApiOperation({ summary: 'Membres de la boutique' })
  list(@Param('restaurantId') restaurantId: string, @CurrentUser() user: User) {
    return this.members.list(user, restaurantId);
  }

  @Post()
  @ApiOperation({ summary: 'Ajouter un membre (compte vendeur existant)' })
  @RequireCapability(AdminCapability.USER_ROLES)
  add(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: AddShopMemberDto,
    @CurrentUser() user: User,
  ) {
    return this.members.add(user, restaurantId, dto);
  }

  @Post(':membershipId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Révoquer un membre, motif obligatoire' })
  @RequireCapability(AdminCapability.USER_ROLES)
  revoke(
    @Param('restaurantId') restaurantId: string,
    @Param('membershipId') membershipId: string,
    @Body() dto: RevokeShopMemberDto,
    @CurrentUser() user: User,
  ) {
    return this.members.revoke(user, restaurantId, membershipId, dto.reason);
  }
}
