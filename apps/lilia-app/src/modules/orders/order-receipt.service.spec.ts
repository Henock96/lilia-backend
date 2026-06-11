import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderReceiptService } from './order-receipt.service';

// Construit une commande payée valide ; surcharge possible via `over`.
function makeOrder(over: Record<string, any> = {}) {
  return {
    id: 'ckorderid000A1B2C3',
    userId: 'user-1',
    createdAt: new Date('2026-06-11T18:42:00Z'),
    paidAt: new Date('2026-06-11T18:45:00Z'),
    status: 'PAYER',
    subTotal: 3500,
    deliveryFee: 1000,
    serviceFee: 280,
    discountAmount: 0,
    total: 4780,
    paymentMethod: 'MTN_MOMO',
    restaurant: { nom: 'Chez Maman Lilia', ownerId: 'resto-owner-1' },
    user: { nom: 'Henok M.' },
    items: [
      { quantite: 2, prix: 1500, snapshotPrice: 1500, variant: 'Maxi', variantLabel: 'Maxi', product: { nom: 'Poulet braisé' } },
      { quantite: 1, prix: 500, snapshotPrice: 500, variant: 'Standard', variantLabel: null, product: { nom: 'Jus de gingembre' } },
    ],
    ...over,
  };
}

const owner = { id: 'user-1', role: 'CLIENT' } as any;
const admin = { id: 'someone-else', role: 'ADMIN' } as any;
const stranger = { id: 'user-2', role: 'CLIENT' } as any;
const vendorOwner = { id: 'resto-owner-1', role: 'RESTAURATEUR' } as any;
const otherVendor = { id: 'resto-owner-2', role: 'RESTAURATEUR' } as any;

describe('OrderReceiptService', () => {
  let prisma: { order: { findUnique: jest.Mock } };
  let service: OrderReceiptService;

  beforeEach(() => {
    prisma = { order: { findUnique: jest.fn() } };
    service = new OrderReceiptService(prisma as any);
  });

  it('throw NotFound si la commande est absente', async () => {
    prisma.order.findUnique.mockResolvedValue(null);
    await expect(service.generateReceipt('x', owner)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throw Forbidden si le caller n’est ni propriétaire ni admin', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder());
    await expect(service.generateReceipt('x', stranger)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throw BadRequest si la commande n’est pas payée (paidAt null)', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ paidAt: null, status: 'EN_ATTENTE' }));
    await expect(service.generateReceipt('x', owner)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throw BadRequest si la commande est annulée (même payée)', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'ANNULER' }));
    await expect(service.generateReceipt('x', owner)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('renvoie un n° de reçu LF-{année}-{6 derniers car. maj} et un PDF non vide (propriétaire)', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder());
    const { buffer, numero } = await service.generateReceipt('x', owner);
    expect(numero).toBe('LF-2026-A1B2C3');
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('autorise un ADMIN même non propriétaire', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder());
    const { buffer } = await service.generateReceipt('x', admin);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('autorise le RESTAURATEUR propriétaire du restaurant de la commande', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder());
    const { buffer } = await service.generateReceipt('x', vendorOwner);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('refuse un RESTAURATEUR d’un autre restaurant', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder());
    await expect(service.generateReceipt('x', otherVendor)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
