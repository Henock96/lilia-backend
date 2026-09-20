import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

/**
 * Compte les callbacks prestataire **refusés à la porte**.
 *
 * ## Le trou que ce service bouche
 *
 * `PawaPayWebhookController.assertAuthentic` lève un 401 **avant** toute
 * écriture : un callback dont la signature ne passe pas ne laisse donc aucune
 * ligne dans `PaymentEvent`. Conséquence, constatée en production le
 * 20/09/2026 sur 150 événements de paiement dont **zéro** en `source =
 * WEBHOOK` :
 *
 * > On ne peut pas distinguer « pawaPay ne nous a jamais appelés » de
 * > « pawaPay nous appelle et nous refusons tout ».
 *
 * Les deux produisent exactement le même silence en base, et appellent des
 * gestes **opposés** — aller déclarer l'URL de callback dans le tableau de bord
 * du prestataire, ou corriger `PAWAPAY_PUBLIC_KEY` / `PAWAPAY_CALLBACK_IPS`.
 * Sans cette distinction, un exploitant devant un `webhooksEverReceived: 0` ne
 * peut que deviner.
 *
 * ## Pourquoi un compteur Redis, et pas une ligne par refus
 *
 * L'endpoint est **public par construction** : le prestataire ne s'authentifie
 * pas auprès de nous avant qu'on l'ait vérifié. Écrire une ligne en base à
 * chaque appel refusé donnerait donc à un inconnu le droit d'écrire dans notre
 * PostgreSQL autant de fois qu'il le souhaite — on corrigerait un angle mort
 * d'observabilité en ouvrant une amplification de stockage.
 *
 * Un compteur est borné par construction : `INCR` sur une clé par jour et par
 * motif, avec TTL. Mille tentatives coûtent une clé, pas mille lignes. Et pour
 * la question posée — *est-ce que quelqu'un frappe à la porte ?* — un nombre
 * suffit ; le contenu d'un message qu'on n'a pas authentifié n'apprend rien de
 * fiable, et le conserver reviendrait à stocker ce qu'un attaquant a choisi.
 *
 * ## Best-effort, toujours
 *
 * Aucune méthode ne lève. Refuser un callback ne doit jamais dépendre de la
 * disponibilité de Redis : le refus est la décision de sécurité, le comptage
 * n'en est que la trace.
 */
@Injectable()
export class WebhookReceptionMonitor {
  private readonly logger = new Logger(WebhookReceptionMonitor.name);

  /** Trente jours : au-delà, le compteur ne sert plus à diagnostiquer. */
  private static readonly TTL_SECONDS = 30 * 24 * 3600;
  private static readonly PREFIX = 'pawapay:callback:rejected';
  private static readonly LAST_KEY = 'pawapay:callback:lastRejectedAt';

  constructor(@Optional() @InjectRedis() private readonly redis?: Redis) {}

  /**
   * Enregistre un refus. `reason` est une étiquette **fermée** produite par le
   * contrôleur (`signature:…`, `ip-not-allowed`, `not-configured`) — jamais une
   * chaîne venue de la requête, qui ferait de la clé Redis une surface d'entrée.
   */
  async recordRejection(route: string, reason: string): Promise<void> {
    if (!this.redis) return;

    const day = new Date().toISOString().slice(0, 10);
    const label = WebhookReceptionMonitor.sanitize(reason);
    const key = `${WebhookReceptionMonitor.PREFIX}:${day}:${route}:${label}`;

    try {
      await this.redis
        .multi()
        .incr(key)
        .expire(key, WebhookReceptionMonitor.TTL_SECONDS)
        .set(WebhookReceptionMonitor.LAST_KEY, new Date().toISOString())
        .exec();
    } catch (err) {
      this.logger.warn(
        `Comptage du refus de callback échoué : ${(err as Error).message}`,
      );
    }
  }

  /**
   * Résumé des refus sur la fenêtre demandée.
   *
   * `SCAN` et non `KEYS` : `KEYS` parcourt tout l'espace de clés en bloquant le
   * serveur, et ce Redis porte aussi l'idempotence du checkout.
   */
  async summary(days: number): Promise<{
    total: number;
    byReason: Record<string, number>;
    lastRejectedAt: string | null;
    available: boolean;
  }> {
    const empty = {
      total: 0,
      byReason: {},
      lastRejectedAt: null,
      available: false,
    };
    if (!this.redis) return empty;

    try {
      const wanted = WebhookReceptionMonitor.daysWindow(days);
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await this.redis.scan(
          cursor,
          'MATCH',
          `${WebhookReceptionMonitor.PREFIX}:*`,
          'COUNT',
          200,
        );
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');

      const inWindow = keys.filter((k) => {
        const day = k.split(':')[3];
        return wanted.has(day);
      });

      const byReason: Record<string, number> = {};
      let total = 0;

      if (inWindow.length > 0) {
        const values = await this.redis.mget(...inWindow);
        inWindow.forEach((key, i) => {
          const n = Number(values[i] ?? 0);
          if (!Number.isFinite(n) || n <= 0) return;
          // `…:rejected:<jour>:<route>:<motif>` — le motif peut contenir des
          // deux-points (`signature:missing-header`), d'où le `slice`.
          const reason = key.split(':').slice(5).join(':') || 'inconnu';
          byReason[reason] = (byReason[reason] ?? 0) + n;
          total += n;
        });
      }

      const lastRejectedAt = await this.redis.get(
        WebhookReceptionMonitor.LAST_KEY,
      );

      return { total, byReason, lastRejectedAt, available: true };
    } catch (err) {
      this.logger.warn(
        `Lecture des refus de callback échouée : ${(err as Error).message}`,
      );
      return empty;
    }
  }

  /** Les jours de la fenêtre, au format `YYYY-MM-DD`. */
  private static daysWindow(days: number): Set<string> {
    const out = new Set<string>();
    const now = Date.now();
    for (let i = 0; i < days; i++) {
      out.add(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
    }
    return out;
  }

  /** Borne l'étiquette : pas de `*`, pas d'espace, pas de clé à rallonge. */
  private static sanitize(reason: string): string {
    return (
      reason
        .toLowerCase()
        .replace(/[^a-z0-9:_-]/g, '-')
        .slice(0, 40) || 'inconnu'
    );
  }
}
