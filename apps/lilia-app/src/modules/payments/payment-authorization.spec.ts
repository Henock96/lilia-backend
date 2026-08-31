import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { PaymentController } from './controllers/payment.controller';
import { AdminPayoutController } from './controllers/admin-payout.controller';
import { PawaPayWebhookController } from './controllers/pawapay-webhook.controller';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { redactHeaders } from './services/mtn-momo-token.service';

/**
 * Qui a le droit de faire quoi sur l'argent — verrouillé par un test.
 *
 * L'authentification et les rôles sont portés par deux `APP_GUARD` globaux :
 * une route est protégée **par défaut**, et c'est son absence de décorateur qui
 * la protège le plus. Ce dispositif a un angle mort : retirer un `@Roles('ADMIN')`
 * ne casse rien de visible. Le code compile, les tests métier passent, et
 * `POST /admin/orders/:id/payout` — le seul geste qui envoie de l'argent à un
 * tiers — devient accessible à n'importe quel compte connecté.
 *
 * Ce fichier lit les métadonnées réellement posées sur les contrôleurs et
 * échoue si elles changent. Il ne remplace pas les tests du `RolesGuard` (qui
 * vérifient l'application) : il verrouille la **déclaration**, c'est-à-dire la
 * partie qu'un refactor peut effacer sans bruit.
 *
 * ⚠️ Un `@Public()` sur une route de paiement doit rester une décision
 * délibérée : les deux seules ici sont la liste des opérateurs (aucune donnée
 * sensible) et les callbacks du prestataire (authentifiés par signature ou par
 * liste blanche d'IP, jamais par jeton Firebase — pawaPay n'en a pas).
 */
describe('Autorisation — routes de paiement et de reversement', () => {
  type RouteFacts = {
    path: string;
    method: string;
    roles: string[] | undefined;
    isPublic: boolean;
  };

  const METHOD_NAMES: Record<number, string> = {
    [RequestMethod.GET]: 'GET',
    [RequestMethod.POST]: 'POST',
    [RequestMethod.PATCH]: 'PATCH',
    [RequestMethod.PUT]: 'PUT',
    [RequestMethod.DELETE]: 'DELETE',
  };

  /** Lit les métadonnées Nest posées sur chaque méthode d'un contrôleur. */
  function routesOf(
    controller: new (...args: never[]) => object,
  ): RouteFacts[] {
    const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
    const classRoles = Reflect.getMetadata(ROLES_KEY, controller) as
      | string[]
      | undefined;

    const proto = controller.prototype as Record<string, unknown>;
    return Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = proto[name] as object;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
        if (path === undefined) return null;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
        // `getAllAndOverride` : la méthode l'emporte sur la classe, comme le
        // fait le RolesGuard à l'exécution.
        const roles =
          (Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined) ??
          classRoles;
        return {
          path: `/${prefix}/${path}`.replace(/\/+/g, '/').replace(/\/$/, ''),
          method: METHOD_NAMES[method] ?? String(method),
          roles,
          isPublic: Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, handler)),
        } satisfies RouteFacts;
      })
      .filter((r): r is RouteFacts => r !== null);
  }

  const find = (routes: RouteFacts[], method: string, path: string) => {
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) {
      throw new Error(
        `Route ${method} ${path} introuvable. Routes déclarées : ` +
          routes.map((r) => `${r.method} ${r.path}`).join(', '),
      );
    }
    return route;
  };

  // ══════════════════════════════════════════════════════════════════════════
  describe('/payments — encaissement client', () => {
    const routes = routesOf(PaymentController);

    it('la liste des opérateurs est publique, et c’est voulu', () => {
      // L'écran de paiement doit pouvoir l'appeler avant que la commande
      // existe. Elle n'expose que le mode et la disponibilité.
      expect(find(routes, 'GET', '/payments/providers')).toMatchObject({
        isPublic: true,
        roles: undefined,
      });
    });

    it.each([
      ['POST', '/payments'],
      ['GET', '/payments/by-order/:orderId'],
      ['GET', '/payments/:paymentId/status'],
    ])(
      '%s %s exige une authentification, sans restriction de rôle',
      (method, path) => {
        const route = find(routes, method, path);
        // Pas de @Public() : le FirebaseAuthGuard global s'applique.
        expect(route.isPublic).toBe(false);
        // Pas de @Roles() : ouvert à tout compte connecté — la propriété de la
        // commande est vérifiée DANS le service (`getPayableOrder`,
        // `assertPaymentAccess`), pas par le rôle. Un client ne peut donc ni
        // voir ni payer la commande d'un autre.
        expect(route.roles).toBeUndefined();
      },
    );

    it.each([
      ['POST', '/payments/:paymentId/confirm'],
      ['POST', '/payments/:paymentId/reject'],
      ['POST', '/payments/:paymentId/reconcile'],
      ['GET', '/payments/:paymentId/events'],
    ])('%s %s est réservé à l’ADMIN', (method, path) => {
      const route = find(routes, method, path);
      expect(route.isPublic).toBe(false);
      expect(route.roles).toEqual(['ADMIN']);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('/admin — reversement vendeur', () => {
    const routes = routesOf(AdminPayoutController);

    it('TOUTES les routes de reversement sont réservées à l’ADMIN', () => {
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        expect({ ...route, roles: route.roles }).toMatchObject({
          isPublic: false,
          roles: ['ADMIN'],
        });
      }
    });

    it('le geste qui envoie l’argent est nommément couvert', () => {
      // Nommé explicitement plutôt que couvert par la boucle : si quelqu'un
      // déplaçait cette route dans un autre contrôleur, la boucle ci-dessus
      // resterait verte et ne dirait plus rien.
      expect(
        find(routes, 'POST', '/admin/orders/:orderId/payout').roles,
      ).toEqual(['ADMIN']);
      expect(
        find(routes, 'POST', '/admin/orders/:orderId/payout/retry').roles,
      ).toEqual(['ADMIN']);
      expect(
        find(routes, 'PATCH', '/admin/vendors/:restaurantId/payout-account')
          .roles,
      ).toEqual(['ADMIN']);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('/webhooks/pawapay — callbacks du prestataire', () => {
    const routes = routesOf(PawaPayWebhookController);

    it.each([
      ['POST', '/webhooks/pawapay/deposits'],
      ['POST', '/webhooks/pawapay/payouts'],
    ])(
      '%s %s est public — pawaPay n’a pas de jeton Firebase, il signe',
      (method, path) => {
        const route = find(routes, method, path);
        expect(route.isPublic).toBe(true);
        expect(route.roles).toBeUndefined();
      },
    );

    it('deux routes distinctes : l’aiguillage dépôt/reversement n’est pas deviné', () => {
      const paths = routes.map((r) => r.path).sort();
      expect(paths).toEqual([
        '/webhooks/pawapay/deposits',
        '/webhooks/pawapay/payouts',
      ]);
    });
  });
});

/**
 * Secrets et journaux.
 *
 * `docs/PAYMENTS.md` promet que ni jeton d'API ni en-tête `Authorization` ne
 * sont journalisés. La promesse tenait pour pawaPay, pas pour le rail MTN : son
 * intercepteur écrivait `JSON.stringify(config.headers)` dans le **message**,
 * là où la `redact` de pino — qui n'agit que sur les propriétés d'un objet
 * journalisé — n'a aucune prise.
 */
describe('Journaux — aucun secret dans les messages', () => {
  it('masque Authorization et la subscription key, garde le reste', () => {
    const redacted = redactHeaders({
      'Content-Type': 'application/json',
      Authorization: 'Basic c2VjcmV0OnZhbGV1cg==',
      'Ocp-Apim-Subscription-Key': '23d8c479592745da846487db04f9cdb0',
      'X-Reference-Id': 'ref-lisible',
    });

    expect(redacted).toEqual({
      'Content-Type': 'application/json',
      Authorization: '[Redacted]',
      'Ocp-Apim-Subscription-Key': '[Redacted]',
      'X-Reference-Id': 'ref-lisible',
    });
  });

  it('est insensible à la casse de l’en-tête', () => {
    expect(redactHeaders({ authorization: 'Bearer x' })).toEqual({
      authorization: '[Redacted]',
    });
  });

  it('sérialisé, le résultat ne contient plus le secret', () => {
    const serialized = JSON.stringify(
      redactHeaders({ Authorization: 'Bearer super-secret-token' }),
    );
    expect(serialized).not.toContain('super-secret-token');
  });
});
