import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Get,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { CartService } from './cart.service';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { AddMenuToCartDto } from './dto/add-menu-to-cart.dto';

@Controller('cart')
@UseGuards(FirebaseAuthGuard)
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  getCart(@Req() req) {
    return this.cartService.getCart(req.user.uid);
  }

  @Post('add')
  addItem(@Body() addToCartDto: AddToCartDto, @Req() req) {
    return this.cartService.addItem(req.user.uid, addToCartDto);
  }

  @Post('add-menu')
  addMenu(@Body() dto: AddMenuToCartDto, @Req() req) {
    return this.cartService.addMenu(req.user.uid, dto);
  }

  @Patch('items/:id')
  updateItem(
    @Param('id') id: string,
    @Body() updateCartItemDto: UpdateCartItemDto,
    @Req() req,
  ) {
    return this.cartService.updateItemQuantity(
      req.user.uid,
      id,
      updateCartItemDto,
    );
  }

  @Patch('menus/:menuId')
  updateMenuQuantity(
    @Param('menuId') menuId: string,
    @Body() dto: UpdateCartItemDto,
    @Req() req,
  ) {
    return this.cartService.updateMenuQuantity(req.user.uid, menuId, dto);
  }

  @Delete('items/:id')
  removeItem(@Param('id') id: string, @Req() req) {
    return this.cartService.removeItem(req.user.uid, id);
  }

  @Delete('menus/:menuId')
  removeMenu(@Param('menuId') menuId: string, @Req() req) {
    return this.cartService.removeMenu(req.user.uid, menuId);
  }

  @Delete('clear')
  clearCart(@Req() req) {
    return this.cartService.clearCart(req.user.uid);
  }
}
