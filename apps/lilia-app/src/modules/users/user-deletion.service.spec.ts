import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserDeletionService } from './user-deletion.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from '../firebase/firebase.service';
import { UserCacheService } from '../auth/services/user-cache.service';

/**
 * `DELETE /users/me` — anonymisation.
 *
 * Le point non négociable : les commandes et paiements survivent. Un
 * `prisma.user.delete()` ferait disparaître du chiffre d'affaires encaissé (et
 * lèverait un P2003, les FK étant actives depuis Ar1).
 */
describe('UserDeletionService', () => {
  let service: UserDeletionService;

  const activeUser = {
    id: 'u1',
    firebaseUid: 'fb1',
    email: 'jean@example.com',
    nom: 'Jean',
    phone: '061234567',
    role: 'CLIENT',
    driverStatus: null,
    statusUser: 'ACTIVE',
  };

  const tx = {
    adresses: { deleteMany: jest.fn() },
    fcmToken: { deleteMany: jest.fn() },
    cart: { deleteMany: jest.fn() },
    favorite: { deleteMany: jest.fn() },
    review: { deleteMany: jest.fn() },
    loyaltyTransaction: { deleteMany: jest.fn() },
    // Plaque et permis sont des données personnelles : le profil livreur est
    // purgé au même titre que les adresses.
    driverProfile: { deleteMany: jest.fn() },
    user: { update: jest.fn() },
  };

  const prisma = {
    user: { findUnique: jest.fn() },
    order: { count: jest.fn() },
    restaurant: { findFirst: jest.fn() },
    delivery: { count: jest.fn() },
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const firebase = { deleteUserSafe: jest.fn() };
  const userCache = { invalidateOrThrow: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.order.count.mockResolvedValue(0);
    prisma.restaurant.findFirst.mockResolvedValue(null);
    prisma.delivery.count.mockResolvedValue(0);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserDeletionService,
        { provide: PrismaService, useValue: prisma },
        { provide: FirebaseService, useValue: firebase },
        { provide: UserCacheService, useValue: userCache },
      ],
    }).compile();

    service = module.get(UserDeletionService);
  });

  it('anonymise le User sans le supprimer', async () => {
    await service.deleteOwnAccount('u1');

    const data = tx.user.update.mock.calls[0][0].data;
    expect(data.statusUser).toBe('DELETED');
    expect(data.nom).toBeNull();
    expect(data.phone).toBeNull();
    expect(data.email).toBe('deleted-u1@deleted.liliafood.com');
    expect(data.firebaseUid).toBe('deleted-u1');
    expect(data.referralCode).toBeNull();
    expect(data.loyaltyPoints).toBe(0);
  });

  it('purge les données personnelles mais ne touche ni Order ni Payment', async () => {
    await service.deleteOwnAccount('u1');

    expect(tx.adresses.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
    expect(tx.fcmToken.deleteMany).toHaveBeenCalled();
    expect(tx.cart.deleteMany).toHaveBeenCalled();
    expect(tx.favorite.deleteMany).toHaveBeenCalled();
    expect(tx.review.deleteMany).toHaveBeenCalled();
    expect(tx.loyaltyTransaction.deleteMany).toHaveBeenCalled();
    expect(tx.driverProfile.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
    // Aucun delegate order/payment n'est même exposé sur le tx mocké :
    // s'il était appelé, le test planterait.
    expect(Object.keys(tx)).not.toContain('order');
  });

  it('supprime le compte Firebase avec l’UID d’origine, avant renommage', async () => {
    await service.deleteOwnAccount('u1');

    expect(firebase.deleteUserSafe).toHaveBeenCalledWith('fb1');
    expect(userCache.invalidateOrThrow).toHaveBeenCalledWith('fb1');
  });

  it('cache Redis non vidé → succès assorti d’un warning explicite', async () => {
    userCache.invalidateOrThrow.mockRejectedValueOnce(new Error('redis down'));

    const res = await service.deleteOwnAccount('u1');

    expect(res.warning).toContain('5 minutes');
  });

  it('rejoué sur un compte déjà supprimé → succès, aucune écriture', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...activeUser,
      statusUser: 'DELETED',
    });

    const res = await service.deleteOwnAccount('u1');

    expect(res.message).toContain('déjà');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(firebase.deleteUserSafe).not.toHaveBeenCalled();
  });

  it('user inconnu → 404', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.deleteOwnAccount('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('garde-fous (409)', () => {
    it('commande en cours → refus, rien n’est écrit', async () => {
      prisma.order.count.mockResolvedValue(2);

      await expect(service.deleteOwnAccount('u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(firebase.deleteUserSafe).not.toHaveBeenCalled();
    });

    it('ne compte que les commandes non terminales', async () => {
      await service.deleteOwnAccount('u1');

      expect(prisma.order.count).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          status: {
            in: ['EN_ATTENTE', 'PAYER', 'EN_PREPARATION', 'PRET', 'EN_ROUTE'],
          },
        },
      });
    });

    it('propriétaire d’un vendeur → refus nommant la boutique', async () => {
      prisma.restaurant.findFirst.mockResolvedValue({
        id: 'r1',
        nom: 'Chez Lilia',
      });

      await expect(service.deleteOwnAccount('u1')).rejects.toThrow(
        /Chez Lilia/,
      );
    });

    it('livraison en cours (ASSIGNER / ACCEPTER / EN_TRANSIT) → refus', async () => {
      prisma.delivery.count.mockResolvedValue(1);

      await expect(service.deleteOwnAccount('u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.delivery.count).toHaveBeenCalledWith({
        where: {
          delivererId: 'u1',
          // `ACCEPTER` inclus depuis la séparation acceptation / récupération :
          // un livreur qui va chercher un repas a bien une course en cours.
          status: { in: ['ASSIGNER', 'ACCEPTER', 'EN_TRANSIT'] },
        },
      });
    });

    it('driverStatus ON_DELIVERY sans Delivery active → refus quand même', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...activeUser,
        role: 'LIVREUR',
        driverStatus: 'ON_DELIVERY',
      });

      await expect(service.deleteOwnAccount('u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
