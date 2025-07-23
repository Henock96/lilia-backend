import { Controller, Sse, Req } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { fromEvent, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';

@Controller('notifications')
export class NotificationsController {
  constructor(private eventEmitter: EventEmitter2) {}

  @Sse('sse') // You can optionally provide a path
  sse(@Req() req: Request): Observable<MessageEvent> {
    // TODO: Add logic to associate session with a user
    // For now, all connected clients will receive all order events.

    const orderCreated$ = fromEvent(this.eventEmitter, 'order.created');
    const orderUpdated$ = fromEvent(this.eventEmitter, 'order.status.updated');

    return new Observable(subscriber => {
      const createdSub = orderCreated$.subscribe(data => {
        subscriber.next({ data } as MessageEvent);
      });
      const updatedSub = orderUpdated$.subscribe(data => {
        subscriber.next({ data } as MessageEvent);
      });

      req.on('close', () => {
        createdSub.unsubscribe();
        updatedSub.unsubscribe();
        subscriber.complete();
      });
    }).pipe(
      map((data: any) => {
        return new MessageEvent('order_event', { data: JSON.stringify(data.data) });
      }),
    );
  }
}