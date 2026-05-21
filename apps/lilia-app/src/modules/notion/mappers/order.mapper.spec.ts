import { mapOrderToNotion, OrderWithRelations } from './order.mapper';
import { NOTION_PROPS } from '../notion.constants';

describe('mapOrderToNotion', () => {
  const baseOrder: OrderWithRelations = {
    id: 'cl_abc123def456',
    userId: 'user_1',
    status: 'PAYER' as any,
    paymentMethod: 'MTN_MOMO' as any,
    subTotal: 5000 as any,
    deliveryFee: 1000 as any,
    serviceFee: 400 as any,
    discountAmount: 0 as any,
    total: 6400 as any,
    contactPhone: '+242060000000',
    createdAt: new Date('2026-05-17T10:00:00Z'),
    paidAt: new Date('2026-05-17T10:05:00Z'),
    items: [{ id: 'i1' } as any, { id: 'i2' } as any],
    restaurant: { nom: 'Chez Mama' },
    user: { nom: 'Henok', phone: '+242060000000', email: 'h@example.com' },
  } as OrderWithRelations;

  it('maps required scalar properties', () => {
    const props = mapOrderToNotion(baseOrder);
    expect(props[NOTION_PROPS.ORDERS.TITLE]).toEqual({
      title: [{ text: { content: '#DEF456' } }],
    });
    expect(props[NOTION_PROPS.ORDERS.PRISMA_ID]).toEqual({
      rich_text: [{ text: { content: 'cl_abc123def456' } }],
    });
    expect(props[NOTION_PROPS.ORDERS.STATUS]).toEqual({
      select: { name: 'PAYER' },
    });
    expect(props[NOTION_PROPS.ORDERS.TOTAL]).toEqual({ number: 6400 });
    expect(props[NOTION_PROPS.ORDERS.ITEM_COUNT]).toEqual({ number: 2 });
  });

  it('omits paidAt when null', () => {
    const props = mapOrderToNotion({ ...baseOrder, paidAt: null } as any);
    expect(props[NOTION_PROPS.ORDERS.PAID_AT]).toBeUndefined();
    expect(props[NOTION_PROPS.ORDERS.CREATED_AT]).toBeDefined();
  });

  it('falls back to email then short id for customer label', () => {
    const props = mapOrderToNotion({
      ...baseOrder,
      user: null,
    } as OrderWithRelations);
    expect(props[NOTION_PROPS.ORDERS.CUSTOMER]).toEqual({
      rich_text: [{ text: { content: 'user_1' } }],
    });
  });
});
