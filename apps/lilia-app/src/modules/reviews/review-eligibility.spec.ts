import {
  AUTO_PAYOUT_PROOFS,
  DELIVERY_PROOFS,
} from '../orders/order-transition.types';
import {
  REVIEWABLE_PROOFS,
  isReviewableProof,
  orderReviewVerdict,
  publicAuthorName,
} from './review-eligibility';
import { toPublicReview } from './review-public-projection';

describe('Avis — éligibilité (lot B, D4.a)', () => {
  it('seules les remises prouvées ouvrent un avis', () => {
    expect(REVIEWABLE_PROOFS).toEqual([
      'DELIVERY_CODE',
      'PICKUP_CODE',
      'PICKUP_CUSTOMER_CONFIRMED',
      'PICKUP_ADMIN_OVERRIDE',
    ]);
    for (const proof of REVIEWABLE_PROOFS) {
      expect(DELIVERY_PROOFS).toContain(proof);
    }
  });

  it('la clôture admin paie le vendeur mais n’ouvre pas d’avis (D1.c)', () => {
    expect(AUTO_PAYOUT_PROOFS).toContain('DELIVERY_ADMIN_OVERRIDE');
    expect(isReviewableProof('DELIVERY_ADMIN_OVERRIDE')).toBe(false);
    expect(isReviewableProof('DELIVERY_UNVERIFIED')).toBe(false);
    expect(isReviewableProof('PICKUP_VENDOR_DECLARED')).toBe(false);
    expect(isReviewableProof(null)).toBe(false);
  });

  const order = (over: Record<string, unknown> = {}) => ({
    status: 'LIVRER',
    deliveryProof: 'DELIVERY_CODE',
    isDelivery: true,
    delivery: { status: 'LIVRER', delivererId: 'liv1' },
    ...over,
  });
  const none = { vendor: false, driver: false };

  it.each([
    ['livrée avec code', order(), none, { vendor: 'CAN', driver: 'CAN' }],
    [
      'déjà notée',
      order(),
      { vendor: true, driver: false },
      { vendor: 'DONE', driver: 'CAN' },
    ],
    [
      'retrait confirmé : pas de livreur',
      order({
        isDelivery: false,
        deliveryProof: 'PICKUP_CODE',
        delivery: null,
      }),
      none,
      { vendor: 'CAN', driver: 'NO' },
    ],
    [
      'en route',
      order({ status: 'EN_ROUTE', deliveryProof: null }),
      none,
      { vendor: 'NO', driver: 'NO' },
    ],
    [
      'clôture admin',
      order({ deliveryProof: 'DELIVERY_ADMIN_OVERRIDE' }),
      none,
      { vendor: 'NO', driver: 'NO' },
    ],
    [
      'course sans livreur',
      order({ delivery: { status: 'LIVRER', delivererId: null } }),
      none,
      { vendor: 'CAN', driver: 'NO' },
    ],
  ])('%s', (_label, o, existing, expected) => {
    expect(orderReviewVerdict(o as never, existing)).toEqual(expected);
  });

  it.each([
    ['Awa Mabiala', 'Awa M.'],
    ['  jean   paul kimbembe ', 'jean K.'],
    ['Awa', 'Awa'],
    ['', 'Client'],
    [null, 'Client'],
    ['awa@exemple.cg', 'Client'],
    ['061234567', 'Client'],
    ['Awa 😀mabiala', 'Awa 😀.'],
  ])('auteur public de « %s » → « %s »', (nom, expected) => {
    expect(publicAuthorName(nom)).toBe(expected);
  });

  it('projection publique : réponse masquée absente, aucune date de masquage', () => {
    const base = {
      id: 'r1',
      rating: 4,
      comment: 'Bon',
      restaurantId: 'shop',
      createdAt: new Date(),
      updatedAt: new Date(),
      vendorReply: 'Merci !',
      vendorReplyAt: new Date(),
      user: { nom: 'Awa Mabiala', imageUrl: null },
    };
    const visible = toPublicReview({ ...base, vendorReplyHiddenAt: null });
    expect(visible.vendorReply).toBe('Merci !');
    expect(visible.user.nom).toBe('Awa M.');

    const hidden = toPublicReview({ ...base, vendorReplyHiddenAt: new Date() });
    expect(hidden.vendorReply).toBeNull();
    expect(hidden.vendorReplyAt).toBeNull();
    expect(hidden).not.toHaveProperty('vendorReplyHiddenAt');
  });
});
