import { Controller, Sse, Req } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { fromEvent, merge, Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';

@Controller('notifications')
export class NotificationsController {
  constructor(private eventEmitter: EventEmitter2) {}

  @Sse('sse')
  sse(@Req() req: any): Observable<MessageEvent> {
    const user = req.user; // Assumes Firebase guard attaches user
    if (!user) {
      // Or handle unauthorized access appropriately
      return new Observable((subscriber) => subscriber.complete());
    }

    const orderCreated$ = fromEvent(this.eventEmitter, 'order.created');
    const orderUpdated$ = fromEvent(this.eventEmitter, 'order.status.updated');

    return merge(orderCreated$, orderUpdated$).pipe(
      filter((event: any) => {
        const order = event.order;
        // Notifier le client qui a passé la commande
        if (order.userId === user.id) {
          return true;
        }
        // Notifier le restaurateur concerné
        if (event.restaurantOwnerId && event.restaurantOwnerId === user.id) {
          return true;
        }
        return false;
      }),
      map((data: any) => {
        return new MessageEvent('order_event', {
          data: JSON.stringify(data.order),
        });
      }),
    );
  }
}
