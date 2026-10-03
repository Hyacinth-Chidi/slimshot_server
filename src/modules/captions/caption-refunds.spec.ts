import { Logger } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { CaptionRefunds } from './caption-refunds';

function build() {
  const ledger = { post: jest.fn(async () => ({ replayed: false })) };
  const audit = { record: jest.fn(async (_e: unknown) => undefined) };
  return { ledger, audit, refunds: new CaptionRefunds(ledger as never, audit as never) };
}

describe('CaptionRefunds', () => {
  it('refunds the charged credits keyed by the job', async () => {
    const { refunds, ledger } = build();
    await refunds.refund('u1', 'cap_x', 6, 'job_failed');
    expect(ledger.post).toHaveBeenCalledWith({
      userId: 'u1',
      type: 'feature_refund',
      amount: 6,
      reference: 'cap_x',
      metadata: { reason: 'job_failed' },
    });
  });

  it.each([
    ['a free job', 'u1', 0],
    ['a job queued before credits existed', undefined, undefined],
  ])('does nothing for %s', async (_label, userId, credits) => {
    const { refunds, ledger } = build();
    await refunds.refund(userId as never, 'cap_x', credits as never, 'job_failed');
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('logs and audits a refund the ledger refuses (account deleted meanwhile), without throwing', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { refunds, ledger, audit } = build();
    ledger.post.mockRejectedValue(appError(404, ErrorCode.NOT_FOUND, 'This account no longer exists.'));
    await expect(refunds.refund('u1', 'cap_x', 6, 'job_failed')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'credits.refund.failed', entityId: 'u1' }),
    );
    error.mockRestore();
  });
});
