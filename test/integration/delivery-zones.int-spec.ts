import { PrismaPg } from '@prisma/adapter-pg';
import {
  DeliveryPriceMode,
  OnboardingStatus,
  PrismaClient,
  VendorType,
} from '@prisma/client';

import { DeliveryZonesService } from '../../apps/lilia-app/src/modules/quartiers/delivery-zones.service';
import { QuartiersService } from '../../apps/lilia-app/src/modules/quartiers/quartiers.service';
import { RestaurantsService } from '../../apps/lilia-app/src/modules/restaurants/restaurants.service';
import { RestaurantAccessService } from '../../apps/lilia-app/src/modules/restaurants/restaurant-access.service';

/**
 * Tarification par zone, sur un **vrai PostgreSQL**.
 *
 * Les tests unitaires mockent Prisma : ils vérifient qu'un service appelle la
 * bonne requête, jamais que l'état résultant facture le bon montant au client.
 * Or le défaut d'origine était exactement de cette nature — un vendeur en
 * `ZONE_BASED` sans aucune zone, dont **toutes** les livraisons retombaient sur
 * `fixedDeliveryFee` sous le libellé « Zone par défaut », sans qu'aucun écran
 * ni aucune validation ne le signale.
 *
 * Ce fichier rejoue la configuration réellement observée en production le
 * 05/09/2026 :
 *
 * | Vendeur | mode | repli | zones | effet |
 * |---|---|---|---|---|
 * | Le Cosy Lounge Brazza | ZONE_BASED | 1000 | **0** | tout au repli |
 * | Chez Maman Lili | ZONE_BASED | 1000 | 3 (6 quartiers / 21) | 71 % au repli |
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Zones de livraison — tarification réelle (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let zones: DeliveryZonesService;
  let quartiers: QuartiersService;
  let restaurants: RestaurantsService;

  // `Restaurant.ownerId` est `@unique` : un compte propriétaire ne détient
  // qu'un seul vendeur. Il en faut donc deux.
  const OWNER_LILI = 'dz-owner-lili';
  const OWNER_LILI_UID = 'dz-owner-lili-uid';
  const OWNER_COSY = 'dz-owner-cosy';
  const ADMIN = 'dz-admin';
  const ADMIN_UID = 'dz-admin-uid';
  const LILI = 'dz-lili';
  const COSY = 'dz-cosy';

  /** Sous-ensemble du référentiel réel : 6 couverts + 2 orphelins. */
  const QUARTIERS = [
    'Poto-Poto',
    'Marché Poto-Poto',
    'Djiri',
    'Massengo',
    'Nkombo',
    'Ngamakosso',
    'Bacongo',
    'Makélékélé',
  ];
  const qid = (nom: string) => `dz-q-${QUARTIERS.indexOf(nom)}`;

  async function createVendor(
    id: string,
    nom: string,
    fee: number,
    ownerId: string,
  ) {
    await prisma.restaurant.create({
      data: {
        id,
        nom,
        adresse: 'Brazzaville',
        phone: '060000000',
        ownerId,
        vendorType: VendorType.RESTAURANT,
        onboardingStatus: OnboardingStatus.ACTIVATED,
        adminApproved: true,
        isActive: true,
        isOpen: true,
        supportsDelivery: true,
        deliveryPriceMode: DeliveryPriceMode.ZONE_BASED,
        fixedDeliveryFee: fee,
      },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();

    zones = new DeliveryZonesService(prisma as never);
    quartiers = new QuartiersService(prisma as never);
    restaurants = new RestaurantsService(
      prisma as never,
      new RestaurantAccessService(prisma as never) as never,
      {} as never,
      {} as never,
    );

    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "QuartierZone", "DeliveryZone", "Adresses",
                     "Restaurant", "Quartier", "User"
      RESTART IDENTITY CASCADE
    `);

    await prisma.user.createMany({
      data: [
        {
          id: OWNER_LILI,
          firebaseUid: OWNER_LILI_UID,
          email: 'owner-lili@dz.test',
          role: 'RESTAURATEUR',
        },
        {
          id: OWNER_COSY,
          firebaseUid: 'dz-owner-cosy-uid',
          email: 'owner-cosy@dz.test',
          role: 'RESTAURATEUR',
        },
        {
          id: ADMIN,
          firebaseUid: ADMIN_UID,
          email: 'admin@dz.test',
          role: 'ADMIN',
        },
      ],
    });

    await prisma.quartier.createMany({
      data: QUARTIERS.map((nom) => ({
        id: qid(nom),
        nom,
        ville: 'Brazzaville',
      })),
    });

    await createVendor(LILI, 'Chez Maman Lili', 1000, OWNER_LILI);
    await createVendor(COSY, 'Le Cosy Lounge Brazza', 1000, OWNER_COSY);

    // La grille réelle de « Chez Maman Lili ».
    await zones.createDeliveryZone(LILI, OWNER_LILI_UID, {
      zoneName: 'Potal',
      fee: 500,
      quartierIds: [qid('Poto-Poto'), qid('Marché Poto-Poto')],
    });
    await zones.createDeliveryZone(LILI, OWNER_LILI_UID, {
      zoneName: 'Zone Nord',
      fee: 1500,
      quartierIds: [qid('Djiri'), qid('Massengo'), qid('Nkombo')],
    });
    await zones.createDeliveryZone(LILI, OWNER_LILI_UID, {
      zoneName: 'Zone Nord 2',
      fee: 2000,
      quartierIds: [qid('Ngamakosso')],
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Le tarif facturé — ce que paie réellement le client', () => {
    it('applique le tarif de la zone qui contient le quartier', async () => {
      await expect(
        quartiers.calculateDeliveryFee(LILI, qid('Poto-Poto')),
      ).resolves.toMatchObject({ fee: 500, zoneName: 'Potal' });

      await expect(
        quartiers.calculateDeliveryFee(LILI, qid('Ngamakosso')),
      ).resolves.toMatchObject({ fee: 2000, zoneName: 'Zone Nord 2' });
    });

    it('retombe sur le repli pour un quartier hors de toute zone', async () => {
      // Le comportement n'est pas corrigé ici — il est *documenté* et
      // désormais visible : `isDefaultZone` remonte jusqu'à l'interface, et le
      // bandeau de couverture nomme les quartiers concernés avant qu'un client
      // en fasse les frais.
      const bacongo = await quartiers.calculateDeliveryFee(
        LILI,
        qid('Bacongo'),
      );
      expect(bacongo).toMatchObject({
        fee: 1000,
        zoneName: 'Zone par défaut',
        isDefaultZone: true,
      });
    });

    it('le même quartier vaut un prix différent selon le vendeur', async () => {
      // La propriété centrale d'un marketplace : il n'existe aucun tarif de
      // zone global. 500 F chez l'une, 1 000 F (repli) chez l'autre.
      const chezLili = await quartiers.calculateDeliveryFee(
        LILI,
        qid('Poto-Poto'),
      );
      const chezCosy = await quartiers.calculateDeliveryFee(
        COSY,
        qid('Poto-Poto'),
      );

      expect(chezLili.fee).toBe(500);
      expect(chezCosy.fee).toBe(1000);
    });
  });

  describe('Couverture — la règle qui manquait à l’interface', () => {
    it('nomme les quartiers orphelins et le montant qu’ils paieront', async () => {
      const { data } = await zones.getManagedDeliveryZones(LILI, ADMIN_UID);

      expect(data.coverage.totalQuartiers).toBe(QUARTIERS.length);
      expect(data.coverage.coveredQuartiers).toBe(6);
      expect(data.coverage.fallbackFee).toBe(1000);
      expect(data.coverage.uncovered.map((q) => q.nom).sort()).toEqual([
        'Bacongo',
        'Makélékélé',
      ]);
    });

    it('un vendeur sans aucune zone a une couverture nulle', async () => {
      const { data } = await zones.getManagedDeliveryZones(COSY, ADMIN_UID);

      expect(data.zones).toHaveLength(0);
      expect(data.coverage.uncovered).toHaveLength(QUARTIERS.length);
    });

    it('est lisible par l’ADMIN, qui ne possède aucun vendeur', async () => {
      // C'est précisément ce que `GET /quartiers/my-zones` refusait (403) et
      // que `GET /quartiers/restaurant-zones` masquait sur un vendeur non
      // publié (404). L'administrateur n'avait aucune porte.
      await expect(
        zones.getManagedDeliveryZones(LILI, ADMIN_UID),
      ).resolves.toBeDefined();
    });

    it('reste lisible sur un vendeur NON publié', async () => {
      await prisma.restaurant.update({
        where: { id: COSY },
        data: { onboardingStatus: OnboardingStatus.DRAFT },
      });

      await expect(
        zones.getManagedDeliveryZones(COSY, ADMIN_UID),
      ).resolves.toBeDefined();

      // La route publique, elle, doit continuer de le masquer.
      await expect(zones.getRestaurantDeliveryZones(COSY)).rejects.toThrow(
        /non trouvé/i,
      );

      await prisma.restaurant.update({
        where: { id: COSY },
        data: { onboardingStatus: OnboardingStatus.ACTIVATED },
      });
    });
  });

  describe('Un quartier, un seul tarif par vendeur (L-6/L-5/L-7)', () => {
    it('refuse d’ajouter à une zone un quartier déjà couvert par une autre', async () => {
      // Sans cette règle, `calculateDeliveryFee` renvoyait la PREMIÈRE zone
      // trouvée en parcourant un `include` sans `orderBy` : deux clients du
      // même quartier pouvaient payer deux tarifs différents.
      await expect(
        zones.createDeliveryZone(LILI, OWNER_LILI_UID, {
          zoneName: 'Doublon',
          fee: 9999,
          quartierIds: [qid('Poto-Poto')],
        }),
      ).rejects.toThrow(/une seule zone/i);
    });

    it('nomme le quartier ET la zone qui le détient déjà', async () => {
      // Un P2002 brut ne dit ni l'un ni l'autre — or c'est exactement ce qu'il
      // faut savoir pour corriger.
      await expect(
        zones.createDeliveryZone(LILI, OWNER_LILI_UID, {
          zoneName: 'Doublon',
          fee: 9999,
          quartierIds: [qid('Ngamakosso')],
        }),
      ).rejects.toThrow(/Ngamakosso.*Zone Nord 2/i);
    });

    it('la base refuse aussi, indépendamment du service', async () => {
      // Le contrôle applicatif est une traduction ; la garantie est la
      // contrainte. Un script d'administration qui contournerait le service
      // doit se heurter au même mur.
      const potal = await prisma.deliveryZone.findFirstOrThrow({
        where: { restaurantId: LILI, zoneName: 'Zone Nord' },
      });
      await expect(
        prisma.quartierZone.create({
          data: {
            quartierId: qid('Poto-Poto'), // déjà dans « Potal »
            deliveryZoneId: potal.id,
            restaurantId: LILI,
          },
        }),
      ).rejects.toThrow();
    });

    it('la clé étrangère composite interdit un restaurantId qui ment', async () => {
      const potal = await prisma.deliveryZone.findFirstOrThrow({
        where: { restaurantId: LILI, zoneName: 'Potal' },
      });
      await expect(
        prisma.quartierZone.create({
          data: {
            quartierId: qid('Bacongo'),
            deliveryZoneId: potal.id,
            restaurantId: COSY, // pas le propriétaire de la zone
          },
        }),
      ).rejects.toThrow();
    });

    it('deux vendeurs peuvent couvrir le même quartier', async () => {
      // La règle est « un tarif par (vendeur, quartier) », pas « un quartier
      // pour un seul vendeur » — sinon le premier arrivé confisquerait la ville.
      //
      // COSY est repassé en tarif fixe pour ce test : en `ZONE_BASED`, le
      // garde-fou refuserait — à raison — de supprimer sa dernière zone au
      // nettoyage. Les tests suivants le remettent dans l'état qu'ils exigent.
      await prisma.restaurant.update({
        where: { id: COSY },
        data: { deliveryPriceMode: DeliveryPriceMode.FIXED },
      });

      const before = await prisma.quartierZone.count({
        where: { quartierId: qid('Poto-Poto') },
      });
      const { data } = await zones.createDeliveryZone(COSY, ADMIN_UID, {
        zoneName: 'Centre Cosy',
        fee: 750,
        quartierIds: [qid('Poto-Poto')],
      });
      await expect(
        prisma.quartierZone.count({ where: { quartierId: qid('Poto-Poto') } }),
      ).resolves.toBe(before + 1);

      // Le tarif propre à chaque vendeur est déjà couvert plus haut
      // (« le même quartier vaut un prix différent selon le vendeur ») ; ici on
      // ne vérifie que ce que la contrainte autorise en base.
      await zones.deleteDeliveryZone(data.id, ADMIN_UID);
      await expect(
        prisma.deliveryZone.count({ where: { restaurantId: COSY } }),
      ).resolves.toBe(0);
    });

    it('refuse un quartier inexistant, en le nommant (L-7)', async () => {
      await expect(
        zones.createDeliveryZone(COSY, ADMIN_UID, {
          zoneName: 'Fantôme',
          fee: 500,
          quartierIds: ['q-inexistant'],
        }),
      ).rejects.toThrow(/q-inexistant/);
    });

    it('la mise à jour ne laisse jamais une zone tarifée sans quartier (L-5)', async () => {
      // Les trois écritures vivaient hors transaction : un échec entre le
      // `deleteMany` et le `createMany` laissait une zone vide — donc
      // inopérante, et silencieusement.
      const zone = await prisma.deliveryZone.findFirstOrThrow({
        where: { restaurantId: LILI, zoneName: 'Zone Nord' },
      });

      await expect(
        zones.updateDeliveryZone(zone.id, OWNER_LILI_UID, {
          // « Poto-Poto » appartient à « Potal » : le rejet doit survenir
          // AVANT toute suppression.
          quartierIds: [qid('Djiri'), qid('Poto-Poto')],
        }),
      ).rejects.toThrow(/une seule zone/i);

      // La couverture d'origine est intacte.
      await expect(
        prisma.quartierZone.count({ where: { deliveryZoneId: zone.id } }),
      ).resolves.toBe(3);
    });

    it('accepte de reconduire les quartiers déjà dans la zone modifiée', async () => {
      const zone = await prisma.deliveryZone.findFirstOrThrow({
        where: { restaurantId: LILI, zoneName: 'Zone Nord' },
      });

      await zones.updateDeliveryZone(zone.id, OWNER_LILI_UID, {
        fee: 1600,
        quartierIds: [qid('Djiri'), qid('Massengo'), qid('Nkombo')],
      });

      await expect(
        quartiers.calculateDeliveryFee(LILI, qid('Djiri')),
      ).resolves.toMatchObject({ fee: 1600 });
    });
  });

  describe('L’invariant ZONE_BASED — fermé sur les chemins d’écriture', () => {
    it('refuse de basculer en ZONE_BASED sans zone', async () => {
      await prisma.restaurant.update({
        where: { id: COSY },
        data: { deliveryPriceMode: DeliveryPriceMode.FIXED },
      });

      await expect(
        restaurants.updateDeliverySettings(COSY, ADMIN_UID, {
          deliveryPriceMode: DeliveryPriceMode.ZONE_BASED,
        }),
      ).rejects.toThrow(/zone de livraison/i);

      // Et la base n'a pas bougé : le refus précède l'écriture.
      const after = await prisma.restaurant.findUniqueOrThrow({
        where: { id: COSY },
        select: { deliveryPriceMode: true },
      });
      expect(after.deliveryPriceMode).toBe(DeliveryPriceMode.FIXED);
    });

    it('accepte la bascule dès qu’une zone existe', async () => {
      await zones.createDeliveryZone(COSY, ADMIN_UID, {
        zoneName: 'Centre',
        fee: 800,
        quartierIds: [qid('Bacongo')],
      });

      await restaurants.updateDeliverySettings(COSY, ADMIN_UID, {
        deliveryPriceMode: DeliveryPriceMode.ZONE_BASED,
      });

      await expect(
        quartiers.calculateDeliveryFee(COSY, qid('Bacongo')),
      ).resolves.toMatchObject({ fee: 800, zoneName: 'Centre' });
    });

    it('refuse de supprimer la dernière zone d’un vendeur ZONE_BASED', async () => {
      const { data } = await zones.getManagedDeliveryZones(COSY, ADMIN_UID);
      expect(data.zones).toHaveLength(1);

      await expect(
        zones.deleteDeliveryZone(data.zones[0].id, ADMIN_UID),
      ).rejects.toThrow(/dernière/i);

      // La zone est toujours là — c'est ce qui empêche le retour à l'état
      // « Cosy Lounge » observé en production.
      await expect(
        prisma.deliveryZone.count({ where: { restaurantId: COSY } }),
      ).resolves.toBe(1);
    });

    it('laisse supprimer la dernière zone une fois repassé en tarif fixe', async () => {
      // La porte de sortie doit rester ouverte, sinon le correctif enferme les
      // vendeurs qu'il protège.
      await restaurants.updateDeliverySettings(COSY, ADMIN_UID, {
        deliveryPriceMode: DeliveryPriceMode.FIXED,
      });

      const { data } = await zones.getManagedDeliveryZones(COSY, ADMIN_UID);
      await zones.deleteDeliveryZone(data.zones[0].id, ADMIN_UID);

      await expect(
        prisma.deliveryZone.count({ where: { restaurantId: COSY } }),
      ).resolves.toBe(0);
    });

    it('la suppression d’une zone emporte ses rattachements (cascade SQL)', async () => {
      // Le `deleteMany` manuel a été retiré : c'est PostgreSQL qui cascade
      // depuis l'activation des clés étrangères. Si la cascade manquait, ces
      // lignes survivraient en orphelines.
      await expect(
        prisma.quartierZone.count({
          where: { deliveryZone: { restaurantId: COSY } },
        }),
      ).resolves.toBe(0);
    });
  });
});
