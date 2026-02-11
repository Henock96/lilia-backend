import {
  Controller,
  Post,
  UseGuards,
  Req,
  Get,
  Body,
  Param,
  Patch,
  Delete,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { CreateOrderDto } from './dto/create-order.dto';
import { Roles } from 'src/firebase/roles.decorator';
import { RolesGuard } from 'src/firebase/roles.guard';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

@ApiTags('Orders')
@Controller('orders')
@UseGuards(FirebaseAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('checkout')
  createOrderFromCart(@Req() req, @Body() createOrderDto: CreateOrderDto) {
    return this.ordersService.createOrderFromCart(req.user.uid, createOrderDto);
  }

  @Get('users')
  OrdersByUsers(
    @Req() req,
    @Query('page') page: number,
    @Query('limit') limit: number,
  ) {
    return this.ordersService.findOrdersClient(page, limit, req.user.uid);
  }
  @Get('restaurants')
  RestaurantOrders(@Req() req) {
    return this.ordersService.findRestaurantOrders(req.user.uid);
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

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('CLIENT')
  deleteOrder(@Param('id') id: string, @Req() req) {
    return this.ordersService.deleteOrder(id, req.user.uid);
  }

  @Post(':id/reorder')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Recommander une commande précédente',
    description:
      "Ajoute tous les produits d'une commande précédente au panier actuel. Les produits indisponibles sont ignorés.",
  })
  @ApiParam({
    name: 'id',
    description: 'ID de la commande à recommander',
    type: 'string',
  })
  @ApiResponse({
    status: 201,
    description: 'Commande ajoutée au panier avec succès',
  })
  @ApiResponse({
    status: 400,
    description: "Le panier contient déjà des articles d'un autre restaurant",
  })
  @ApiResponse({
    status: 403,
    description: 'Cette commande ne vous appartient pas',
  })
  @ApiResponse({ status: 404, description: 'Commande non trouvée' })
  reorderOrder(@Param('id') id: string, @Req() req) {
    return this.ordersService.reorderFromPreviousOrder(id, req.user.uid);
  }
}
