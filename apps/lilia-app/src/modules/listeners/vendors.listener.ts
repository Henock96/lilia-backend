import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  VendorActivatedEvent,
  VendorApprovedEvent,
  VendorCreatedEvent,
  VendorReadyEvent,
  VendorSuspendedEvent,
} from '../vendors/events/vendor-events';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';

@Injectable()
export class VendorsListener {
  private readonly logger = new Logger(VendorsListener.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  @OnEvent('vendor.created', { async: true })
  async handleVendorCreated(event: VendorCreatedEvent) {
    this.logger.log(
      `Nouveau vendeur ${event.vendor.vendorType} : ${event.vendor.nom} ` +
        `(adminApproved=${event.vendor.adminApproved})`,
    );

    // Tout nouveau vendeur non auto-approuvé déclenche une alerte admin
    // (hygiène marketplace — admin curate la liste avant exposition publique)
    if (!event.isPendingApproval) return;

    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', statusUser: 'ACTIVE' },
      select: { id: true },
    });
    await Promise.allSettled(
      admins.map((admin) =>
        this.notifications.sendPushNotification(
          admin.id,
          '🛎️ Nouveau vendeur à valider',
          `${event.vendor.nom} (${event.vendor.vendorType}) attend votre validation.`,
          { vendorId: event.vendor.id, type: 'vendor_pending_approval' },
        ),
      ),
    );
  }

  @OnEvent('vendor.approved', { async: true })
  async handleVendorApproved(event: VendorApprovedEvent) {
    this.logger.log(
      `Vendeur approuvé : ${event.vendor.nom} (par ${event.approvedByAdminId})`,
    );

    // Notifier le owner de la bonne nouvelle
    await this.notifications.sendPushNotification(
      event.vendor.ownerId,
      '🎉 Votre boutique est en ligne',
      `${event.vendor.nom} est désormais visible par les clients.`,
      { vendorId: event.vendor.id, type: 'vendor_approved' },
    );
  }

  /**
   * La configuration d'un vendeur vient d'être complétée : un administrateur
   * peut l'activer. Sans ce signal, une boutique prête pouvait attendre des
   * jours qu'un admin pense à consulter la file.
   */
  @OnEvent('vendor.ready', { async: true })
  async handleVendorReady(event: VendorReadyEvent) {
    this.logger.log(`Vendeur prêt à activer : ${event.vendor.nom}`);
    await this.notifyAdmins(
      '✅ Boutique prête à activer',
      `${event.vendor.nom} a terminé sa configuration.`,
      { vendorId: event.vendor.id, type: 'vendor_ready' },
    );
  }

  @OnEvent('vendor.activated', { async: true })
  async handleVendorActivated(event: VendorActivatedEvent) {
    this.logger.log(`Vendeur activé : ${event.vendor.nom}`);

    // Le message dépend de la validation marketplace : annoncer « visible par
    // les clients » à un vendeur encore en attente d'approbation serait faux, et
    // il attendrait des commandes qui ne viendraient pas.
    const visible = event.vendor.adminApproved;
    await this.notifications.sendPushNotification(
      event.vendor.ownerId,
      visible ? '🎉 Votre boutique est en ligne' : '✅ Boutique activée',
      visible
        ? `${event.vendor.nom} est désormais visible par les clients.`
        : `${event.vendor.nom} est prête. Elle sera visible dès validation par notre équipe.`,
      { vendorId: event.vendor.id, type: 'vendor_activated' },
    );
  }

  /**
   * Un vendeur suspendu doit l'apprendre autrement qu'en constatant l'absence
   * de commandes. Le SMS double le push : une suspension est une information
   * qu'on ne peut pas se permettre de rater faute de token FCM valide.
   */
  @OnEvent('vendor.suspended', { async: true })
  async handleVendorSuspended(event: VendorSuspendedEvent) {
    this.logger.warn(`Vendeur suspendu : ${event.vendor.nom}`);

    await this.notifications.sendPushNotification(
      event.vendor.ownerId,
      '⛔ Boutique suspendue',
      `${event.vendor.nom} n'est plus visible. Motif : ${event.reason}`,
      { vendorId: event.vendor.id, type: 'vendor_suspended' },
    );

    const owner = await this.prisma.user.findUnique({
      where: { id: event.vendor.ownerId },
      select: { phone: true },
    });
    if (owner?.phone) {
      await this.sms.send(
        owner.phone,
        `Lilia Food : votre boutique a ete suspendue. Contactez le support pour en savoir plus.`,
      );
    }
  }

  /** Notifie tous les administrateurs actifs, sans laisser un échec en bloquer un autre. */
  private async notifyAdmins(
    title: string,
    body: string,
    data: Record<string, string>,
  ): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', statusUser: 'ACTIVE' },
      select: { id: true },
    });
    await Promise.allSettled(
      admins.map((admin) =>
        this.notifications.sendPushNotification(admin.id, title, body, data),
      ),
    );
  }
}
