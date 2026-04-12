import {
  Controller,
  Post,
  Body,
  Get,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { CartService } from './cart.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { AddMenuToCartDto } from './dto/add-menu-to-cart.dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DecodedIdToken } from 'firebase-admin/auth';


@ApiTags('Panier')
@ApiBearerAuth()
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  getCart(@FirebaseUser() firebaseUser: DecodedIdToken) {
    return this.cartService.getCart(firebaseUser.uid);
  }

  @Post('add')
  addItem(@Body() addToCartDto: AddToCartDto, @FirebaseUser() firebaseUser: DecodedIdToken) {
    return this.cartService.addItem(firebaseUser.uid, addToCartDto);
  }

  @Post('add-menu')
  addMenu(@Body() dto: AddMenuToCartDto, @FirebaseUser() firebaseUser: DecodedIdToken) {
    return this.cartService.addMenu(firebaseUser.uid, dto);
  }

  @Patch('items/:id')
  updateItem(
    @Param('id') id: string,
    @Body() updateCartItemDto: UpdateCartItemDto,
    @FirebaseUser() firebaseUser: DecodedIdToken,
  ) {
    return this.cartService.updateItemQuantity(
      firebaseUser.uid,
      id,
      updateCartItemDto,
    );
  }

  @Patch('menus/:menuId')
  updateMenuQuantity(
    @Param('menuId') menuId: string,
    @Body() dto: UpdateCartItemDto,
    @FirebaseUser() firebaseUser: DecodedIdToken,
  ) {
    return this.cartService.updateMenuQuantity(firebaseUser.uid, menuId, dto);
  }

  @Delete('items/:id')
  removeItem(@Param('id') id: string, @FirebaseUser() firebaseUser: DecodedIdToken) {
    return this.cartService.removeItem(firebaseUser.uid, id);
  }

  @Delete('menus/:menuId')
  removeMenu(@Param('menuId') menuId: string, @FirebaseUser() firebaseUser: DecodedIdToken) {
    return this.cartService.removeMenu(firebaseUser.uid, menuId);
  }

  @Delete('clear')
  clearCart(@FirebaseUser() firebaseUser: DecodedIdToken) {
    return this.cartService.clearCart(firebaseUser.uid);
  }
}
