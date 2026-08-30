import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { EmailModule } from '../email/email.module';
import { SmsModule } from '../sms/sms.module';
import { VendorInvitationService } from './vendor-invitation.service';
import { VendorReadinessService } from './vendor-readiness.service';

/**
 * Cœur métier vendeurs, **sans aucun contrôleur**.
 *
 * `OutboxModule` — importé par le worker — a besoin de `VendorInvitationService`
 * pour rattraper les invitations non parties. Lui faire importer `VendorsModule`
 * monterait `/vendors/*` et `/admin/vendors/*` sur le processus worker, qui ne
 * charge ni `AuthModule` ni ses `APP_GUARD` : les routes d'administration s'y
 * retrouveraient **sans authentification**. C'est exactement l'incident décrit
 * dans `CLAUDE.local.md` (« le worker ne démarrait pas — et allait exposer une
 * API non authentifiée »).
 *
 * ⚠️ Règle : ce module ne déclare jamais de `controllers`, et n'importe jamais
 * un module qui en déclare. `worker.module.spec.ts` parcourt le graphe et
 * échoue en nommant le fautif si la règle est enfreinte.
 */
@Module({
  imports: [PrismaModule, FirebaseModule, EmailModule, SmsModule],
  providers: [VendorInvitationService, VendorReadinessService],
  exports: [VendorInvitationService, VendorReadinessService],
})
export class VendorsCoreModule {}
