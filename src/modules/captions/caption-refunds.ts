import { Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service';
import { CreditTxType } from '../../generated/prisma/enums';
import { LedgerService } from '../credits/ledger.service';

/** Gives back what a failed caption job was charged. Never throws: a refund problem is logged and audited. */
@Injectable()
export class CaptionRefunds {
  private readonly logger = new Logger(CaptionRefunds.name);

  constructor(
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  async refund(userId: string | undefined, jobId: string, credits: number | undefined, reason: string): Promise<void> {
    // Jobs queued before credits existed carry neither; free jobs charged nothing.
    if (!userId || !credits || credits <= 0) return;
    try {
      await this.ledger.post({
        userId,
        type: CreditTxType.feature_refund,
        amount: credits,
        reference: jobId,
        metadata: { reason },
      });
    } catch (err) {
      this.logger.error(
        `Refund of ${credits} credits for caption job ${jobId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.audit.record({
        actorType: 'system',
        action: 'credits.refund.failed',
        entityType: 'User',
        entityId: userId,
        after: { jobId, credits, reason },
      });
    }
  }
}
