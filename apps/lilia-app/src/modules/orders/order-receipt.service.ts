import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { User } from '@prisma/client';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { PrismaService } from '../../prisma/prisma.service';
import { renderPdf } from './order-receipt-pdf.util';

@Injectable()
export class OrderReceiptService {
  constructor(private readonly prisma: PrismaService) {}

  async generateReceipt(orderId: string, caller: User): Promise<{ buffer: Buffer; numero: string }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        restaurant: { select: { nom: true, ownerId: true } },
        user: { select: { nom: true } },
        items: { include: { product: { select: { nom: true } } } },
      },
    });

    if (!order) throw new NotFoundException('Commande introuvable.');
    // Autorisé : le client propriétaire de la commande, un ADMIN, ou le
    // RESTAURATEUR propriétaire du restaurant de la commande (admin web).
    const isClientOwner = order.userId === caller.id;
    const isAdmin = caller.role === 'ADMIN';
    const isVendorOwner =
      caller.role === 'RESTAURATEUR' && order.restaurant.ownerId === caller.id;
    if (!isClientOwner && !isAdmin && !isVendorOwner) {
      throw new ForbiddenException('Accès refusé.');
    }
    if (!order.paidAt || order.status === 'ANNULER') {
      throw new BadRequestException('Reçu disponible uniquement pour une commande payée.');
    }

    const numero = this.buildNumero(order.id, order.createdAt);
    const buffer = await renderPdf(this.buildDoc(order, numero));
    return { buffer, numero };
  }

  private buildNumero(id: string, createdAt: Date): string {
    const year = new Date(createdAt).getFullYear();
    return `LF-${year}-${id.slice(-6).toUpperCase()}`;
  }

  private fmtDate(d: Date): string {
    const p = (n: number) => `${n}`.padStart(2, '0');
    const dt = new Date(d);
    return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
  }

  private fmt(n: number): string {
    return `${Math.round(n)}`;
  }

  private paymentLabel(method: string): string {
    return method === 'MTN_MOMO' ? 'MTN MoMo' : 'Airtel Money';
  }

  private buildDoc(order: any, numero: string): TDocumentDefinitions {
    const row = (label: string, value: string) => ({
      columns: [
        { text: label, fontSize: 8, color: '#71717a' },
        { text: value, fontSize: 8, alignment: 'right' },
      ],
      margin: [0, 1, 0, 1] as [number, number, number, number],
    });

    const itemRows = order.items.map((it: any) => {
      const label = `${it.quantite}x ${it.product.nom} (${it.variantLabel ?? it.variant})`;
      const lineTotal = (it.snapshotPrice ?? it.prix) * it.quantite;
      return {
        columns: [
          { text: label, fontSize: 8 },
          { text: this.fmt(lineTotal), fontSize: 8, alignment: 'right' },
        ],
        margin: [0, 1, 0, 1] as [number, number, number, number],
      };
    });

    const totals: any[] = [
      row('Sous-total', this.fmt(order.subTotal)),
      row('Livraison', this.fmt(order.deliveryFee)),
      row('Frais service (8%)', this.fmt(order.serviceFee)),
    ];
    if (order.discountAmount > 0) {
      totals.push(row('Remise', `-${this.fmt(order.discountAmount)}`));
    }

    return {
      pageSize: { width: 220, height: 'auto' },
      pageMargins: [16, 16, 16, 16],
      defaultStyle: { font: 'Roboto' },
      content: [
        { text: 'LILIA FOOD', bold: true, fontSize: 14, alignment: 'center' },
        { text: 'Reçu de commande', fontSize: 8, color: '#71717a', alignment: 'center', margin: [0, 0, 0, 8] },
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 188, y2: 0, dash: { length: 2 }, lineColor: '#d4d4d8' }] },
        { text: '', margin: [0, 0, 0, 6] },
        row('Reçu N°', numero),
        row('Commande N°', order.id),
        row('Date', this.fmtDate(order.createdAt)),
        row('Payé le', this.fmtDate(order.paidAt)),
        row('Vendeur', order.restaurant.nom),
        row('Client', order.user?.nom ?? 'Client'),
        { text: '', margin: [0, 0, 0, 6] },
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 188, y2: 0, dash: { length: 2 }, lineColor: '#d4d4d8' }] },
        { text: '', margin: [0, 0, 0, 6] },
        ...itemRows,
        { text: '', margin: [0, 0, 0, 6] },
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 188, y2: 0, dash: { length: 2 }, lineColor: '#d4d4d8' }] },
        { text: '', margin: [0, 0, 0, 6] },
        ...totals,
        {
          columns: [
            { text: 'TOTAL', bold: true, fontSize: 11 },
            { text: `${this.fmt(order.total)} XAF`, bold: true, fontSize: 11, alignment: 'right' },
          ],
          margin: [0, 4, 0, 4] as [number, number, number, number],
        },
        { text: '', margin: [0, 0, 0, 6] },
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 188, y2: 0, dash: { length: 2 }, lineColor: '#d4d4d8' }] },
        { text: '', margin: [0, 0, 0, 6] },
        { text: `Payé par ${this.paymentLabel(order.paymentMethod)} - PAYÉ`, fontSize: 8, alignment: 'center' },
        { text: 'Merci de votre commande !', fontSize: 8, color: '#71717a', alignment: 'center', margin: [0, 4, 0, 0] },
      ],
    };
  }
}
