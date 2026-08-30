import { Restaurant, VendorType } from '@prisma/client';

/**
 * Type d'entrée `OutboxEvent` portant l'invitation d'activation d'un vendeur.
 *
 * Déclaré ici et non dans `VendorOnboardingService` : le dispatcher d'outbox
 * en a besoin, et il vit dans un module chargé par le worker. Importer la
 * constante depuis le service y tirerait tout son graphe de dépendances.
 */
export const VENDOR_INVITATION_EVENT = 'vendor.invitation';

export class VendorCreatedEvent {
  constructor(
    public readonly vendor: Restaurant,
    public readonly createdByAdminId: string,
    public readonly timestamp: Date = new Date(),
  ) {}

  get isPendingApproval(): boolean {
    return !this.vendor.adminApproved;
  }

  get vendorType(): VendorType {
    return this.vendor.vendorType;
  }
}

export class VendorApprovedEvent {
  constructor(
    public readonly vendor: Restaurant,
    public readonly approvedByAdminId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

/**
 * Le vendeur a terminé sa configuration : toutes les cases bloquantes de la
 * checklist sont cochées et un administrateur peut l'activer.
 *
 * Distinct de `vendor.approved` : approuver relève de la validation
 * marketplace (« ce commerce a-t-il sa place chez nous »), être prêt relève de
 * la complétude (« sa boutique est-elle utilisable »). Les deux peuvent
 * survenir dans n'importe quel ordre.
 */
export class VendorReadyEvent {
  constructor(
    public readonly vendor: Restaurant,
    public readonly timestamp: Date = new Date(),
  ) {}
}

/** Un administrateur a activé le vendeur : sa boutique devient publiable. */
export class VendorActivatedEvent {
  constructor(
    public readonly vendor: Restaurant,
    public readonly activatedByAdminId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

/** Un administrateur a suspendu le vendeur ; il doit en être informé. */
export class VendorSuspendedEvent {
  constructor(
    public readonly vendor: Restaurant,
    public readonly reason: string,
    public readonly suspendedByAdminId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}
