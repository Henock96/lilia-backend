import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import {
  PUBLIC_VENDOR_SELECT,
  WITHHELD_VENDOR_FIELDS,
} from './vendor-visibility';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationService } from './pagination/pagination.service';
import { AdminAuditService } from '../modules/admin-audit/admin-audit.service';
import { VendorsService } from '../modules/vendors/vendors.service';
import { RestaurantQueryService } from '../modules/restaurants/restaurant-query.service';

/**
 * **Ce qu'une lecture publique de vendeur a le droit de servir.**
 *
 * ## Le défaut que ces tests rendent impossible à réintroduire
 *
 * Les cinq lectures publiques de vendeur passaient un `include:` Prisma. Or
 * `include` ne sélectionne que des **relations** : tous les champs scalaires du
 * modèle partent avec, sans qu'on ait à les nommer. `GET /vendors` servait donc
 * à un inconnu, sans jeton :
 *
 * ```
 * $ curl https://lilia-backend.onrender.com/vendors?limit=10
 *   "payoutPhoneNumber": "2420644…"   ← le numéro Mobile Money qui encaisse
 *   "payoutAccountName": "Cassandra"     tout le chiffre d'affaires du vendeur
 *   "commissionPercent": …            ← ses conditions commerciales
 *   "email": "…@gmail.com"            ← l'adresse du propriétaire
 * ```
 *
 * Personne n'a écrit cette ligne. Les colonnes de reversement ont été ajoutées
 * au modèle en août 2026, et les cinq requêtes se sont mises à les publier
 * **sans qu'aucune d'elles ne change**. C'est la propriété à corriger, pas les
 * six noms de champs du jour : le prochain `payoutPhoneNumber` n'existe pas
 * encore.
 *
 * ## Pourquoi ce fichier tient en deux propriétés
 *
 * 1. **Toute colonne du modèle est classée.** Publiée ou retenue, jamais
 *    implicite. Une colonne ajoutée demain casse ce test tant qu'un humain ne
 *    l'a pas rangée d'un côté ou de l'autre — c'est le seul moment où la
 *    question « faut-il la rendre publique ? » se pose au bon endroit.
 * 2. **Les cinq requêtes sont exercées pour de vrai** et on lit ce qu'elles
 *    passent à Prisma. Vérifier la constante sans vérifier les appelants
 *    laisserait un service repasser en `include:` sans rien casser — ce serait
 *    de nouveau un test qui mesure autre chose que ce qu'il annonce.
 */
describe('Projection publique des vendeurs', () => {
  /** Toutes les colonnes scalaires de `Restaurant`, telles que Prisma les connaît. */
  const SCALARS = Object.keys(Prisma.RestaurantScalarFieldEnum);

  const published = Object.keys(PUBLIC_VENDOR_SELECT);
  const withheld = Object.keys(WITHHELD_VENDOR_FIELDS);

  describe('la liste blanche couvre le modèle', () => {
    it('classe chaque colonne de Restaurant : publiée ou retenue', () => {
      const classées = new Set([...published, ...withheld]);
      const oubliées = SCALARS.filter((f) => !classées.has(f));

      // Le message importe autant que l'assertion : il dit quoi faire.
      expect({ oubliées }).toEqual({ oubliées: [] });
    });

    it('ne classe aucune colonne des deux côtés à la fois', () => {
      const deuxFois = published.filter((f) => withheld.includes(f));
      expect(deuxFois).toEqual([]);
    });

    it('ne nomme aucune colonne absente du modèle', () => {
      const fantômes = [...published, ...withheld].filter(
        (f) => !SCALARS.includes(f),
      );
      expect(fantômes).toEqual([]);
    });
  });

  describe('les colonnes sensibles sont retenues', () => {
    // Écrites à la main, et non dérivées de la constante : une spec qui
    // dérive ses attentes de ce qu'elle teste ne vérifie que sa propre
    // cohérence. C'est le piège déjà rencontré sur la machine à états, dont
    // les 204 cas prouvaient que `assertTransition` sait lire la matrice, et
    // jamais que la matrice est juste.
    it.each([
      ['payoutPhoneNumber', 'numéro Mobile Money qui encaisse tout le CA'],
      ['payoutProvider', 'opérateur du compte de reversement'],
      ['payoutAccountName', 'titulaire du compte de reversement'],
      ['payoutVerifiedAt', 'état de vérification du compte'],
      ['payoutVerifiedById', 'administrateur ayant vérifié'],
      ['commissionPercent', 'condition commerciale négociée'],
      ['email', 'adresse personnelle du propriétaire'],
      ['ownerId', 'identifiant interne de compte'],
    ])('%s reste hors des réponses publiques (%s)', (champ) => {
      expect(PUBLIC_VENDOR_SELECT).not.toHaveProperty(champ);
      expect(WITHHELD_VENDOR_FIELDS).toHaveProperty(champ);
    });
  });

  describe('les requêtes publiques emploient réellement la projection', () => {
    const VENDEUR = {
      id: 'v1',
      nom: 'Chez Maman Lili',
      products: [],
      menuDuJour: [],
      _count: { products: 0 },
    };

    let vendors: VendorsService;
    let restaurants: RestaurantQueryService;
    let prisma: {
      restaurant: {
        findFirst: jest.Mock;
        findMany: jest.Mock;
        count: jest.Mock;
      };
      order: { groupBy: jest.Mock };
      review: { groupBy: jest.Mock };
      product: { fields: Record<string, string> };
      $transaction: jest.Mock;
    };

    beforeEach(async () => {
      prisma = {
        restaurant: {
          findFirst: jest.fn().mockResolvedValue(VENDEUR),
          findMany: jest.fn().mockResolvedValue([VENDEUR]),
          count: jest.fn().mockResolvedValue(1),
        },
        order: { groupBy: jest.fn().mockResolvedValue([]) },
        review: { groupBy: jest.fn().mockResolvedValue([]) },
        product: { fields: { availableFrom: 'F', availableUntil: 'U' } },
        $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          VendorsService,
          RestaurantQueryService,
          { provide: PrismaService, useValue: prisma },
          { provide: PaginationService, useValue: {} },
          { provide: EventEmitter2, useValue: { emit: jest.fn() } },
          { provide: AdminAuditService, useValue: { record: jest.fn() } },
        ],
      }).compile();

      vendors = module.get(VendorsService);
      restaurants = module.get(RestaurantQueryService);
    });

    /**
     * Les cinq routes publiques, avec l'appel de service qui les sert.
     *
     * `findPopular` part de `order.groupBy` : sans vendeur en tête de
     * classement, elle ressort avant d'interroger `restaurant`, et le test ne
     * vérifierait rien. D'où le `groupBy` semé ci-dessous.
     */
    const ROUTES: [string, () => Promise<unknown>, 'findFirst' | 'findMany'][] =
      [
        [
          'GET /vendors',
          () => vendors.findAll({ page: 1, limit: 20 } as never),
          'findMany',
        ],
        ['GET /vendors/:id', () => vendors.findOne('v1'), 'findFirst'],
        ['GET /restaurants', () => restaurants.findAll(1, 20), 'findMany'],
        ['GET /restaurants/:id', () => restaurants.findOne('v1'), 'findFirst'],
        [
          'GET /restaurants/popular',
          async () => {
            prisma.order.groupBy.mockResolvedValue([
              { restaurantId: 'v1', _count: { restaurantId: 3 } },
            ]);
            return restaurants.findPopular(6);
          },
          'findMany',
        ],
      ];

    it.each(ROUTES)(
      '%s passe un select, jamais un include',
      async (_route, appel, méthode) => {
        await appel();

        const args = prisma.restaurant[méthode].mock.calls[0][0];
        expect(args.select).toBeDefined();
        expect(args.include).toBeUndefined();
      },
    );

    it.each(ROUTES)(
      '%s ne demande aucune colonne retenue',
      async (_route, appel, méthode) => {
        await appel();

        const args = prisma.restaurant[méthode].mock.calls[0][0];
        const demandées = Object.keys(args.select ?? {});
        const fuites = demandées.filter((f) => withheld.includes(f));

        expect({ fuites }).toEqual({ fuites: [] });
      },
    );

    it.each(ROUTES)(
      '%s demande bien toute la liste blanche',
      async (_route, appel, méthode) => {
        await appel();

        const args = prisma.restaurant[méthode].mock.calls[0][0];
        const demandées = new Set(Object.keys(args.select ?? {}));
        const manquantes = published.filter((f) => !demandées.has(f));

        // Sans cette assertion, retirer un champ utile de la projection
        // partagée passerait inaperçu : les deux tests précédents restent
        // verts sur un `select` vide.
        expect({ manquantes }).toEqual({ manquantes: [] });
      },
    );
  });
});
