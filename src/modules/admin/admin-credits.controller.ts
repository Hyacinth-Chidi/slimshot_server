import { Controller, Get, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { ReconciliationService } from '../credits/reconciliation.service';

@Controller('api/admin/v1/credits')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminCreditsController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  /** Users whose cached balance differs from their ledger sum. Empty means the books balance. */
  @Get('reconciliation')
  @RequirePermission('credits.manage')
  async check() {
    return { success: true as const, data: { mismatches: await this.reconciliation.check() } };
  }
}
