import {
  Controller,
  Post,
  UseGuards,
  Req,
  Get,
  Body,
  Param,
  Patch,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { CreateOrderDto } from './dto/create-order.dto';
import { Roles } from 'src/firebase/roles.decorator';
import { RolesGuard } from 'src/firebase/roles.guard';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

@Controller('orders')
@UseGuards(FirebaseAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('checkout')
  createOrderFromCart(@Req() req, @Body() createOrderDto: CreateOrderDto) {
    return this.ordersService.createOrderFromCart(req.user.uid, createOrderDto);
  }

  @Get('me')
  OrdersByUsers(@Req() req) {
    return this.ordersService.findMyOrders(req.user.uid);
  }

  @Patch(':id/cancel')
  @UseGuards(RolesGuard)
  @Roles('CLIENT')
  cancelOrder(@Param('id') id: string, @Req() req) {
    return this.ordersService.cancelOrder(id, req.user.uid);
  }

  @Patch(':id/status')
  @UseGuards(RolesGuard)
  @Roles('RESTAURATEUR')
  updateOrderStatus(
    @Param('id') id: string,
    @Req() req,
    @Body() updateOrderStatusDto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateOrderStatusByRestaurateur(
      id,
      req.user.uid,
      updateOrderStatusDto.status,
    );
  }
}
