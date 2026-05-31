/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  VendorApprovedEvent,
  VendorCreatedEvent,
} from '../vendors/events/vendor-events';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class VendorsListener {
  private readonly logger = new Logger(VendorsListener.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
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
}
