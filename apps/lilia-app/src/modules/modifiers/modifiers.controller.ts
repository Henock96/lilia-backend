import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { DecodedIdToken } from 'firebase-admin/auth';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  AttachModifierGroupsDto,
  CreateModifierGroupDto,
  ModifierTargetDto,
  ReorderModifierGroupsDto,
  SetModifierOptionAvailabilityDto,
  UpdateModifierGroupDto,
} from './dto/modifier-group.dto';
import { ModifiersService } from './modifiers.service';

/**
 * F3-09 — éditeur d'options du vendeur (et assistance ADMIN).
 *
 * Sous `/products/manage/…`, à côté de la vue gestionnaire du catalogue :
 * ce sont des écritures de catalogue, soumises au même arbitre de propriété
 * (`resolveTargetRestaurant`). `restaurantId` n'est lu que pour un ADMIN.
 *
 * Chemins à 3–4 segments : aucun ne peut être capturé par `/products/:id`,
 * `/products/:id/stock` ou `/products/:id/availability`.
 */
@ApiTags('Options & suppléments')
@ApiBearerAuth()
@Controller('products/manage')
@Roles('RESTAURATEUR', 'ADMIN')
export class ModifiersController {
  constructor(private readonly modifiers: ModifiersService) {}

  @Get('modifier-groups')
  @ApiOperation({ summary: "Bibliothèque de groupes d'options du vendeur" })
  list(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query() query: ModifierTargetDto,
  ) {
    return this.modifiers.list(fbUser.uid, query.restaurantId);
  }

  @Post('modifier-groups')
  @ApiOperation({ summary: "Créer un groupe d'options (et ses options)" })
  create(
    @FirebaseUser() fbUser: DecodedIdToken,
    @CurrentUser() user: User,
    @Body() dto: CreateModifierGroupDto,
  ) {
    return this.modifiers.createGroup(fbUser.uid, user.role, dto);
  }

  /** ⚠️ Déclarée avant `modifier-groups/:id`. */
  @Patch('modifier-groups/reorder')
  @ApiOperation({ summary: 'Ordonner la bibliothèque' })
  reorder(
    @FirebaseUser() fbUser: DecodedIdToken,
    @CurrentUser() user: User,
    @Body() dto: ReorderModifierGroupsDto,
  ) {
    return this.modifiers.reorderGroups(fbUser.uid, user.role, dto);
  }

  @Patch('modifier-groups/:id')
  @ApiOperation({
    summary: 'Modifier un groupe ; `options` = liste complète voulue',
  })
  update(
    @FirebaseUser() fbUser: DecodedIdToken,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateModifierGroupDto,
  ) {
    return this.modifiers.updateGroup(fbUser.uid, user.role, id, dto);
  }

  @Delete('modifier-groups/:id')
  @ApiOperation({ summary: "Supprimer un groupe d'options" })
  remove(
    @FirebaseUser() fbUser: DecodedIdToken,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query() query: ModifierTargetDto,
  ) {
    return this.modifiers.removeGroup(
      fbUser.uid,
      user.role,
      id,
      query.restaurantId,
    );
  }

  @Patch('modifier-options/:id/availability')
  @ApiOperation({ summary: 'Rupture / remise en vente d’une option' })
  availability(
    @FirebaseUser() fbUser: DecodedIdToken,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: SetModifierOptionAvailabilityDto,
  ) {
    return this.modifiers.setOptionAvailability(fbUser.uid, user.role, id, dto);
  }

  @Put(':productId/modifier-groups')
  @ApiOperation({
    summary: "Groupes d'options d'un produit (remplacement complet, ordonné)",
  })
  attach(
    @FirebaseUser() fbUser: DecodedIdToken,
    @CurrentUser() user: User,
    @Param('productId') productId: string,
    @Body() dto: AttachModifierGroupsDto,
  ) {
    return this.modifiers.setProductGroups(
      fbUser.uid,
      user.role,
      productId,
      dto,
    );
  }
}
