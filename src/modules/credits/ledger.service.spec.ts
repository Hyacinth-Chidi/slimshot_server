import { HttpException } from '@nestjs/common';

import { FakeCreditDb } from '../../../test/fakes/fake-credit-db';
import { CreditTxType } from '../../generated/prisma/enums';
import { LedgerService } from './ledger.service';

function build(balance = 0, status: 'active' | 'suspended' | 'deleted' = 'active') {
  const db = new FakeCreditDb();
  db.addUser('u1', balance, status);
  return { db, ledger: new LedgerService(db.prisma() as never) };
}

const grant = (amount: number, reference = 'u1', type: CreditTxType = CreditTxType.signup_bonus) => ({
  userId: 'u1',
  type,
  amount,
  reference,
});
const charge = (amount: number, reference: string) => ({
  userId: 'u1',
  type: CreditTxType.feature_charge,
  amount: -amount,
  reference,
  requireActive: true,
});

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: HttpException) => e,
  );
}

describe('LedgerService.post', () => {
  it('grants credits and records the balance after', async () => {
    const { db, ledger } = build(10);
    const { transaction, replayed } = await ledger.post(grant(100));
    expect(replayed).toBe(false);
    expect(transaction).toMatchObject({ amount: 100, balanceAfter: 110, idempotencyKey: 'signup_bonus:u1' });
    expect(db.users.get('u1')?.creditBalance).toBe(110);
  });

  it('refuses a charge the balance cannot cover, with required and balance, writing nothing', async () => {
    const { db, ledger } = build(5);
    const error = await errorOf(ledger.post(charge(6, 'job-1')));
    expect(error.getStatus()).toBe(402);
    expect(error.getResponse()).toMatchObject({ code: 'INSUFFICIENT_CREDITS', details: { required: 6, balance: 5 } });
    expect(db.users.get('u1')?.creditBalance).toBe(5);
    expect(db.ledger).toHaveLength(0);
  });

  it('never overdraws under concurrent charges', async () => {
    const { db, ledger } = build();
    await ledger.post(grant(100));
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => ledger.post(charge(30, `job-${n}`))));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    expect(db.users.get('u1')?.creditBalance).toBe(10);
    expect(db.ledgerSum('u1')).toBe(10);
  });

  it('applies one reference once, even when two arrive together', async () => {
    const { db, ledger } = build();
    const [a, b] = await Promise.all([
      ledger.post(grant(5, 'admob-tx-1', CreditTxType.rewarded_ad)),
      ledger.post(grant(5, 'admob-tx-1', CreditTxType.rewarded_ad)),
    ]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(db.users.get('u1')?.creditBalance).toBe(5);
    expect(db.ledger).toHaveLength(1);
  });

  it('replays an earlier charge instead of refusing it after the balance dropped', async () => {
    const { db, ledger } = build();
    await ledger.post(grant(10));
    await ledger.post(charge(10, 'job-1'));
    const again = await ledger.post(charge(10, 'job-1'));
    expect(again.replayed).toBe(true);
    expect(db.users.get('u1')?.creditBalance).toBe(0);
  });

  it('refuses spending for a suspended account but still lets it receive credits', async () => {
    const { ledger } = build(50, 'suspended');
    const error = await errorOf(ledger.post(charge(5, 'job-1')));
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    await expect(ledger.post(grant(5, 'adj-1', CreditTxType.admin_adjustment))).resolves.toMatchObject({ replayed: false });
  });

  it('refuses a deleted account', async () => {
    const { ledger } = build(0, 'deleted');
    const error = await errorOf(ledger.post(grant(5)));
    expect(error.getStatus()).toBe(404);
  });

  it('joins an outer transaction instead of opening its own', async () => {
    const { db, ledger } = build();
    const prisma = db.prisma();
    await prisma.$transaction((tx) => ledger.post(grant(5), tx as never));
    expect(db.transactionCalls).toBe(1);
    expect(db.users.get('u1')?.creditBalance).toBe(5);
  });

  it.each([0, 1.5])('rejects the amount %p', async (amount) => {
    const { ledger } = build();
    await expect(ledger.post(grant(amount))).rejects.toThrow('non-zero integers');
  });
});
