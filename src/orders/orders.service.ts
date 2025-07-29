import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { NotificationsService } from 'src/notifications/notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  /**
   * Crée une commande à partir du panier de l'utilisateur.
   * Utilise une transaction pour garantir l'intégrité des données.
   */
  async createOrderFromCart(
    firebaseUid: string,
    createOrderDto: CreateOrderDto,
  ) {
    const { adresseId, paymentMethod } = createOrderDto;

    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        cart: {
          include: {
            items: {
              include: {
                product: true,
                variant: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    // 1. Vérifier l'adresse de livraison
    const deliveryAddress = await this.prisma.adresses.findUnique({
      where: { id: adresseId },
    });
    if (!deliveryAddress) {
      throw new NotFoundException(
        "L'adresse de livraison spécifiée n'existe pas.",
      );
    }
    if (deliveryAddress.userId !== user.id) {
      throw new ForbiddenException('Cette adresse ne vous appartient pas.');
    }

    // 2. Vérifier le panier
    const cart = user.cart;
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Votre panier est vide.');
    }

    const cartItems = cart.items;
    const firstItemRestaurantId = cartItems[0].product.restaurantId;

    // 3. Vérifier que tous les articles proviennent du même restaurant
    const allItemsFromSameRestaurant = cartItems.every(
      (item) => item.product.restaurantId === firstItemRestaurantId,
    );
    if (!allItemsFromSameRestaurant) {
      throw new BadRequestException(
        'Tous les articles de votre panier doivent provenir du même restaurant.',
      );
    }

    // 4. Calculer les montants
    const subTotal = cartItems.reduce((total, item) => {
      return total + item.variant.prix * item.quantite;
    }, 0);

    const deliveryFee = parseFloat(process.env.DELIVERY_FEE || '500');
    const total = subTotal + deliveryFee;

    // Formatter l'adresse pour le snapshot
    const deliveryAddressString = `${deliveryAddress.rue}, ${deliveryAddress.ville}, ${deliveryAddress.country}`;

    // 5. Exécuter la création de la commande et la suppression du panier dans une transaction
    const order = await this.prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          userId: user.id,
          restaurantId: firstItemRestaurantId,
          subTotal,
          deliveryFee,
          total,
          deliveryAddress: deliveryAddressString,
          paymentMethod,
          status: 'EN_ATTENTE',
          items: {
            create: cartItems.map((item) => ({
              productId: item.productId,
              quantite: item.quantite,
              prix: item.variant.prix,
              variant: item.variant.label || 'Standard',
            })),
          },
        },
        include: {
          items: true,
        },
      });

      // 6. Vider le panier
      await tx.cartItem.deleteMany({
        where: {
          cartId: cart.id,
        },
      });

      return newOrder;
    });

    // Récupérer l'ID du propriétaire du restaurant pour la notification
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: firstItemRestaurantId },
    });

    if (restaurant) {
      // Notifier le client
      this.notificationsService.sendToUser(user.id, {
        type: 'order_created',
        message: `Votre commande #${order.id.substring(0, 8)} a été créée.`,
        order,
      });

      // Notifier le restaurateur
      this.notificationsService.sendToUser(restaurant.ownerId, {
        type: 'new_order',
        message: `Nouvelle commande #${order.id.substring(0, 8)} reçue.`,
        order,
      });
    }

    return order;
  }

  /**
   * Récupère les commandes d'un client spécifique.
   */
  async findMyOrders(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    return this.prisma.order.findMany({
      where: { userId: user.id },
      include: {
        restaurant: { select: { nom: true, imageUrl: true } },
        items: {
          include: {
            product: {
              select: {
                nom: true,
                description: true,
                imageUrl: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Récupère les commandes d'un restaurant spécifique.
   */
  async findRestaurantOrders(firebaseUid: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { owner: { firebaseUid } },
    });

    if (!restaurant) {
      throw new NotFoundException(
        'Restaurant non trouvé pour cet utilisateur.',
      );
    }

    return this.prisma.order.findMany({
      where: { restaurantId: restaurant.id },
      include: {
        items: { include: { product: { select: { nom: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Annule une commande pour un client.
   */
  async cancelOrder(orderId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurant: true },
    });

    if (!order) {
      throw new NotFoundException('Commande non trouvée.');
    }

    if (order.userId !== user.id) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à annuler cette commande.",
      );
    }

    if (order.status !== 'EN_ATTENTE') {
      throw new BadRequestException(
        'Cette commande ne peut plus être annulée.',
      );
    }

    const updatedOrder = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'ANNULER' },
    });

    // Notifier le client de l'annulation
    this.notificationsService.sendToUser(user.id, {
      type: 'order_status_updated',
      message: `Votre commande #${updatedOrder.id.substring(0, 8)} a été annulée.`,
      order: updatedOrder,
    });

    // Notifier le restaurateur de l'annulation
    this.notificationsService.sendToUser(order.restaurant.ownerId, {
      type: 'order_status_updated',
      message: `La commande #${updatedOrder.id.substring(0, 8)} a été annulée par le client.`,
      order: updatedOrder,
    });

    return updatedOrder;
  }

  /**
   * Met à jour le statut d'une commande par un restaurateur.
   */
  async updateOrderStatusByRestaurateur(
    orderId: string,
    firebaseUid: string,
    newStatus: any,
  ) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user || user.role !== 'RESTAURATEUR') {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à effectuer cette action.",
      );
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurant: true },
    });

    if (!order) {
      throw new NotFoundException('Commande non trouvée.');
    }

    if (order.restaurant.ownerId !== user.id) {
      throw new ForbiddenException(
        "Cette commande n'appartient pas à votre restaurant.",
      );
    }

    // Ici, vous pourriez ajouter une logique de machine à états pour valider les transitions.
    // Par exemple, un restaurateur ne peut pas passer une commande à 'LIVRER'.
    const allowedStatusUpdates = [
      'EN_PREPARATION',
      'PRET',
      'LIVRER',
      'ANNULER',
    ];
    if (!allowedStatusUpdates.includes(newStatus)) {
      throw new BadRequestException(
        `Statut de mise à jour invalide: ${newStatus}`,
      );
    }

    const updatedOrder = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: newStatus },
    });

    // Notifier le client du changement de statut
    this.notificationsService.sendToUser(order.userId, {
      type: 'order_status_updated',
      message: `Le statut de votre commande #${updatedOrder.id.substring(0, 8)} est maintenant : ${newStatus}.`,
      order: updatedOrder,
    });

    return updatedOrder;
  }
}
