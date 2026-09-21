import { RequestContext } from './request-context';

/**
 * Propagation de l'identifiant de requête hors du cycle HTTP.
 *
 * ## Ce qui existait déjà, et ce qui manquait
 *
 * `pinoHttp.genReqId` (app.module) réutilise un `X-Request-Id` entrant ou en
 * génère un, et **le renvoie au client** : la corrélation front ↔ back
 * fonctionne déjà, et chaque ligne de journal d'une requête le porte.
 *
 * Ce qui manquait est la suite du trajet. Une commande déclenche une écriture
 * d'outbox, un appel prestataire, un cron de reprise — et aucun de ces
 * maillons ne savait de quelle requête il provenait. Reconstituer « ce client
 * a payé à 14 h 03, qu'est-ce qui en a découlé ? » imposait de passer par
 * `orderId` et d'espérer que chaque étape l'ait journalisé.
 *
 * ## Pourquoi `AsyncLocalStorage` et pas un paramètre de plus
 *
 * Faire descendre un `requestId` en paramètre traverserait une dizaine de
 * signatures de services qui n'ont aucune raison métier de le connaître — et la
 * première méthode qui oublierait de le transmettre romprait la chaîne en
 * silence. `AsyncLocalStorage` est le mécanisme prévu par Node pour exactement
 * ce besoin : le contexte suit la continuation, sans être visible.
 *
 * ⚠️ Il ne franchit PAS les frontières de processus. Un événement d'outbox
 * dépilé par le worker ne « retrouve » pas la requête d'origine par magie :
 * c'est pourquoi l'identifiant est **écrit dans la charge utile** de l'outbox,
 * qui, elle, est durable.
 */
describe('RequestContext', () => {
  it('rend undefined hors de toute requête', () => {
    // Un cron n'a pas de requête d'origine, et doit pouvoir le dire.
    expect(RequestContext.requestId()).toBeUndefined();
  });

  it('expose l’identifiant à l’intérieur du périmètre', () => {
    RequestContext.run('req-42', () => {
      expect(RequestContext.requestId()).toBe('req-42');
    });
  });

  it('suit les frontières asynchrones', async () => {
    // Le cœur du sujet : le contexte doit survivre à un `await`, sinon il ne
    // sert à rien dans du code qui fait des entrées-sorties.
    await RequestContext.run('req-async', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      expect(RequestContext.requestId()).toBe('req-async');
    });
  });

  it('isole deux requêtes concurrentes', async () => {
    // Sans isolation, deux clients simultanés se verraient attribuer le même
    // identifiant — ce qui est pire que pas d'identifiant du tout, puisque la
    // corrélation deviendrait mensongère.
    const seen: string[] = [];

    const one = RequestContext.run('req-A', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.push(RequestContext.requestId()!);
    });
    const two = RequestContext.run('req-B', async () => {
      seen.push(RequestContext.requestId()!);
    });

    await Promise.all([one, two]);

    expect(seen.sort()).toEqual(['req-A', 'req-B']);
  });

  it('rend le contexte au périmètre parent en sortant', () => {
    RequestContext.run('outer', () => {
      RequestContext.run('inner', () => {
        expect(RequestContext.requestId()).toBe('inner');
      });
      expect(RequestContext.requestId()).toBe('outer');
    });
  });
});
