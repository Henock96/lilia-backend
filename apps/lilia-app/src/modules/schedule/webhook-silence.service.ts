import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { IncidentSeverity, IncidentType } from '@prisma/client';
import * as Sentry from '@sentry/nestjs';

import { PrismaService } from '../../prisma/prisma.service';
import { CronLockService } from '../../common/locks/cron-lock.service';

/**
 * Détecte qu'**aucun callback prestataire n'arrive plus**, et le dit.
 *
 * ## Pourquoi cette surveillance existe
 *
 * Le 20/09/2026, la production tournait depuis trois semaines en
 * `PAYMENT_MODE=PAWAPAY`. Sur 150 événements de paiement enregistrés, **zéro**
 * portait `source = WEBHOOK` : la voie nominale de confirmation n'avait jamais
 * fonctionné une seule fois. Personne ne l'avait vu.
 *
 * Ce n'est pas une panne bruyante, et c'est bien le problème : **deux replis
 * masquaient l'absence**. L'application cliente interroge `GET /payments/:id/
 * status` tant que l'utilisateur regarde son écran, et le cron de
 * réconciliation rattrape le reste toutes les deux minutes. Les paiements
 * aboutissaient donc — plus lentement, et en reposant entièrement sur un filet
 * dont personne ne savait qu'il était devenu le seul.
 *
 * C'est la forme de panne la plus coûteuse à découvrir tard : le jour où la
 * réconciliation s'arrête (verrou Redis coincé, worker mort, quota API), plus
 * rien ne confirme quoi que ce soit, et l'incident précédent — invisible —
 * aura consommé la marge de sécurité.
 *
 * ## Ce que ce cron mesure exactement
 *
 * La question n'est pas « des callbacks arrivent-ils ? » dans l'absolu — un
 * dimanche sans commande n'en produit aucun, et alerter là-dessus apprendrait
 * à l'exploitant à ignorer l'alerte. La question est :
 *
 * > **Y a-t-il eu de l'activité de paiement sans qu'aucun callback ne
 * > l'accompagne ?**
 *
 * On ne se déclenche donc que si des événements terminaux ont bien été
 * enregistrés sur la fenêtre (le prestataire a tranché des transactions) et
 * qu'aucun d'eux n'est venu par webhook. Sans activité : rien à dire.
 *
 * ## Pourquoi un `Incident` et pas seulement Sentry
 *
 * L'alerte Sentry existait déjà sur le refus de callback
 * (`pawapay.callback_rejected`) et n'a rien changé : elle part vers un service
 * tiers que l'exploitation n'interroge pas. Un `Incident` est visible depuis
 * `GET /incidents`, c'est-à-dire depuis les deux back-offices, au même endroit
 * que les autres anomalies d'exploitation. L'alerte doit atterrir là où
 * quelqu'un regarde déjà.
 */
@Injectable()
export class WebhookSilenceService {
  private readonly logger = new Logger(WebhookSilenceService.name);

  /**
   * Fenêtre d'observation. Six heures : assez long pour qu'un creux d'activité
   * nocturne ne déclenche rien, assez court pour qu'une journée de production
   * ne s'écoule pas avant qu'on sache.
   */
  private static readonly WINDOW_HOURS = 6;

  /** Une seule alerte ouverte à la fois : on signale un état, pas chaque tour. */
  private static readonly TITLE =
    'Aucun callback prestataire reçu sur la période';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly cronLock: CronLockService,
  ) {}

  @Cron('15 */6 * * *', { name: 'webhook-silence-check' })
  async check(): Promise<void> {
    await this.cronLock.runExclusively('webhook-silence-check', 300, () =>
      this.checkUnlocked(),
    );
  }

  private async checkUnlocked(): Promise<void> {
    // En mode MANUAL, aucun prestataire n'émet de callback : l'absence est le
    // fonctionnement nominal, pas une anomalie.
    const mode = this.config.get<string>('PAYMENT_MODE') ?? 'MANUAL';
    if (mode === 'MANUAL') return;

    const since = new Date(
      Date.now() - WebhookSilenceService.WINDOW_HOURS * 3600_000,
    );

    const [activity, webhooks] = await Promise.all([
      this.prisma.paymentEvent.count({ where: { receivedAt: { gte: since } } }),
      this.prisma.paymentEvent.count({
        where: { receivedAt: { gte: since }, source: 'WEBHOOK' },
      }),
    ]);

    if (webhooks > 0) {
      // La voie nominale fonctionne. Si une alerte était ouverte, elle décrit
      // un état révolu : on la clôt, sinon la file d'incidents se remplit de
      // problèmes déjà résolus et cesse d'être lue.
      await this.resolveOpenAlert();
      return;
    }

    // Pas de webhook, mais pas d'activité non plus : il n'y a rien à conclure.
    // Alerter ici apprendrait à ignorer l'alerte.
    if (activity === 0) return;

    const total = await this.prisma.paymentEvent.count({
      where: { source: 'WEBHOOK' },
    });

    const message =
      `${activity} événement(s) de paiement sur ${WebhookSilenceService.WINDOW_HOURS} h, ` +
      `aucun par callback prestataire (${total} depuis l'origine). ` +
      'Les paiements ne sont confirmés que par l’interrogation du client et le ' +
      'cron de réconciliation. Diagnostic et conduite à tenir : ' +
      'GET /admin/payments/webhook-health.';

    this.logger.error(`🚨 [WEBHOOK] ${message}`);
    Sentry.captureMessage(`pawapay.webhook_silence — ${message}`, 'error');
    await this.openAlertOnce(message);
  }

  /**
   * Ouvre l'incident s'il n'y en a pas déjà un ouvert.
   *
   * Sans cette garde, le cron en créerait un toutes les six heures et la file
   * deviendrait illisible — le bruit fait à l'alerte ce que le silence faisait
   * au webhook.
   */
  private async openAlertOnce(description: string): Promise<void> {
    const existing = await this.prisma.incident.findFirst({
      where: {
        type: IncidentType.PAYMENT_FAILED,
        title: WebhookSilenceService.TITLE,
        status: { in: ['OPEN', 'IN_PROGRESS'] },
      },
      select: { id: true },
    });
    if (existing) return;

    await this.prisma.incident
      .create({
        data: {
          type: IncidentType.PAYMENT_FAILED,
          severity: IncidentSeverity.HIGH,
          title: WebhookSilenceService.TITLE,
          description,
        },
      })
      .catch((err: Error) =>
        // Une surveillance qui fait tomber le processus qu'elle surveille est
        // pire que pas de surveillance.
        this.logger.error(`Ouverture de l’incident échouée : ${err.message}`),
      );
  }

  private async resolveOpenAlert(): Promise<void> {
    await this.prisma.incident
      .updateMany({
        where: {
          type: IncidentType.PAYMENT_FAILED,
          title: WebhookSilenceService.TITLE,
          status: { in: ['OPEN', 'IN_PROGRESS'] },
        },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      })
      .catch((err: Error) =>
        this.logger.warn(`Clôture de l’incident échouée : ${err.message}`),
      );
  }
}
