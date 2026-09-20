import { diagnoseWebhookReception } from './controllers/admin-payout.controller';

/**
 * **La règle de décision qui transforme un zéro en geste.**
 *
 * `webhooksEverReceived: 0` a été lisible pendant trois semaines en production
 * sans que personne n'en fasse rien — parce qu'il admet deux lectures opposées
 * et que l'endpoint ne tranchait pas :
 *
 * - le prestataire ne nous appelle pas → aller déclarer l'URL dans son tableau
 *   de bord ;
 * - le prestataire nous appelle et nous refusons tout → corriger la clé ou la
 *   liste d'IP.
 *
 * Ces tests portent la table de vérité **écrite à la main**, cas par cas. Ils
 * ne dérivent rien de l'implémentation : une spec qui déduit ses attentes de ce
 * qu'elle teste ne vérifie que sa propre cohérence — le piège déjà rencontré
 * sur la machine à états, dont 204 cas prouvaient que `assertTransition` sait
 * lire la matrice, et jamais que la matrice est juste.
 */
describe('diagnoseWebhookReception', () => {
  const base = {
    paymentMode: 'PAWAPAY',
    authConfigured: true,
    webhooksEverReceived: 0,
    rejectedTotal: 0,
    rejectedByReason: {} as Record<string, number>,
    monitorAvailable: true,
  };

  it('se tait hors du mode prestataire — en MANUAL personne n’émet de callback', () => {
    const d = diagnoseWebhookReception({ ...base, paymentMode: 'MANUAL' });

    expect(d.state).toBe('not-applicable');
    expect(d.nextSteps).toEqual([]);
  });

  it('déclare la voie nominale saine dès qu’un callback a été authentifié', () => {
    const d = diagnoseWebhookReception({ ...base, webhooksEverReceived: 1 });

    expect(d.state).toBe('ok');
    expect(d.nextSteps).toEqual([]);
  });

  it('« personne ne frappe » ⇒ envoie déclarer l’URL chez le prestataire', () => {
    const d = diagnoseWebhookReception(base);

    expect(d.state).toBe('action-required');
    expect(d.summary).toContain('ne ');
    // Le geste doit nommer l'endroit où aller, pas décrire le symptôme.
    expect(d.nextSteps.join(' ')).toContain('tableau de bord pawaPay');
    expect(d.nextSteps.join(' ')).toContain('/webhooks/pawapay/deposits');
  });

  it('« il frappe, on refuse sur signature » ⇒ envoie corriger la clé publique', () => {
    const d = diagnoseWebhookReception({
      ...base,
      rejectedTotal: 42,
      rejectedByReason: { 'signature:invalid-digest': 42 },
    });

    expect(d.state).toBe('action-required');
    expect(d.summary).toContain('42');
    expect(d.nextSteps.join(' ')).toContain('PAWAPAY_PUBLIC_KEY');
    // Et surtout : ne doit PAS envoyer configurer le tableau de bord, qui est
    // manifestement déjà fait puisque des appels arrivent.
    expect(d.nextSteps.join(' ')).not.toContain('tableau de bord');
  });

  it('« il frappe, on refuse sur l’adresse » ⇒ envoie compléter la liste d’IP', () => {
    const d = diagnoseWebhookReception({
      ...base,
      rejectedTotal: 7,
      rejectedByReason: { 'ip-not-allowlisted': 7 },
    });

    expect(d.nextSteps.join(' ')).toContain('PAWAPAY_CALLBACK_IPS');
  });

  it('retient le motif de refus le plus fréquent quand il y en a plusieurs', () => {
    const d = diagnoseWebhookReception({
      ...base,
      rejectedTotal: 12,
      rejectedByReason: { 'ip-not-allowlisted': 2, 'signature:missing': 10 },
    });

    expect(d.summary).toContain('signature:missing');
    expect(d.nextSteps.join(' ')).toContain('PAWAPAY_PUBLIC_KEY');
  });

  it('aucune authentification armée ⇒ le webhook refuse tout, et on le dit d’abord', () => {
    const d = diagnoseWebhookReception({ ...base, authConfigured: false });

    expect(d.state).toBe('action-required');
    expect(d.nextSteps.join(' ')).toContain('PAWAPAY_PUBLIC_KEY');
  });

  it('avoue son ignorance quand le compteur de refus est indisponible', () => {
    // Sans Redis, on ne peut pas distinguer les deux cas. Annoncer « personne
    // ne frappe » serait une conclusion que la donnée ne porte pas — et
    // enverrait l'exploitant modifier une configuration peut-être correcte.
    const d = diagnoseWebhookReception({ ...base, monitorAvailable: false });

    expect(d.state).toBe('unknown');
    expect(d.nextSteps.join(' ')).toContain('Redis');
  });
});
