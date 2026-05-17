/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

// On garde l'ancien enum Prisma mais on contrôle les transitions
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  EN_ATTENTE: ['PAYER', 'ANNULER'],
  PAYER: ['EN_PREPARATION', 'ANNULER'],
  EN_PREPARATION: ['PRET'],
  PRET: ['EN_ROUTE'],
  EN_ROUTE: ['LIVRER'],
  LIVRER: [], // terminal
  ANNULER: [],
 
};

// Qui a le droit de faire quelle transition
export const TRANSITION_PERMISSIONS: Partial<
  Record<OrderStatus, ('CLIENT' | 'RESTAURATEUR' | 'ADMIN' | 'LIVREUR')[]>
> = {
  ANNULER: ['CLIENT', 'RESTAURATEUR', 'ADMIN', ],
  PAYER: [ 'ADMIN'], // déclenché par le webhook paiement
  EN_PREPARATION: ['RESTAURATEUR', 'ADMIN'],
  PRET: ['RESTAURATEUR', 'ADMIN'],
  EN_ROUTE: ['RESTAURATEUR', 'ADMIN', 'LIVREUR'],
  LIVRER: ['LIVREUR', 'ADMIN'],
};

@Injectable()
export class OrderStateMachine {
  canTransition(from: OrderStatus, to: OrderStatus): boolean {
    return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
  }

  assertTransition(
    from: OrderStatus,
    to: OrderStatus,
    actor: 'CLIENT' | 'RESTAURATEUR' | 'ADMIN' | 'LIVREUR',
  ): void {
    if (!this.canTransition(from, to)) {
      throw new BadRequestException(
        `Transition invalide : ${from} → ${to}. Transitions autorisées depuis ${from} : [${ORDER_TRANSITIONS[from].join(', ') || 'aucune'}]`,
      );
    }
    const allowed = TRANSITION_PERMISSIONS[to];
    if (allowed && !allowed.includes(actor as any)) {
      throw new BadRequestException(
        `L'acteur "${actor}" n'est pas autorisé à passer la commande en "${to}"`,
      );
    }
  }
}
