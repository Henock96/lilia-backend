import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminAuditService } from './admin-audit.service';

/**
 * Journal d'audit admin. Global : les actions sensibles sont réparties entre
 * `admin/`, `payments/` et `vendors/`, et il ne doit y avoir aucune raison de
 * ne pas pouvoir tracer une action parce qu'un import manque.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [AdminAuditService],
  exports: [AdminAuditService],
})
export class AdminAuditModule {}
