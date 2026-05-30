/* eslint-disable prettier/prettier */
import { Restaurant, VendorType } from '@prisma/client';

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
