import { HttpException } from '@nestjs/common';

import { canonicalEmail } from '../../core/identity/email';
import { IdentityHashService } from '../../core/identity/identity-hash.service';
import { ClaimService } from './claim.service';

const SETTINGS = {
  signupBonusCredits: 100,
  referralInviterCredits: 20,
  referralInviteeCredits: 20,
  referralCapCount: 10,
  referralCapDays: 30,
};

interface UserRow {
  id: string;
  email: string | null;
  claimedAt: Date | null;
  signupIpLimited: boolean;
  username: string | null;
  referralCode: string;
  accountStatus: string;
}

interface State {
  users: UserRow[];
  bonusClaims: Array<{ kind: string; hmac: string }>;
  referrals: Array<{ id: string; inviterId: string; inviteeId: string; outcome: string; createdAt: Date }>;
}

function build(
  opts: { email?: string; ipLimited?: boolean; settings?: Partial<typeof SETTINGS>; claimed?: Date } = {},
) {
  const hashes = new IdentityHashService({ identityHmacSecret: 'h'.repeat(48) } as never);
  const state: State = {
    users: [
      {
        id: 'u1',
        email: opts.email ?? 'ann@example.com',
        claimedAt: opts.claimed ?? null,
        signupIpLimited: !!opts.ipLimited,
        username: null,
        referralCode: 'SELFCODE',
        accountStatus: 'active',
      },
      {
        id: 'u2',
        email: 'bob@example.com',
        claimedAt: new Date(),
        signupIpLimited: false,
        username: 'bob',
        referralCode: 'INVITE22',
        accountStatus: 'active',
      },
      {
        id: 'u3',
        email: 'sus@example.com',
        claimedAt: new Date(),
        signupIpLimited: false,
        username: 'sus',
        referralCode: 'SUSPEND3',
        accountStatus: 'suspended',
      },
    ],
    bonusClaims: [],
    referrals: [],
  };
  let failBonusCreateOnce = false;
  const find = (id: string) => state.users.find((u) => u.id === id) as UserRow;
  const client = {
    user: {
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => ({ ...find(where.id) })),
      findUnique: jest.fn(async ({ where }: { where: { referralCode?: string; username?: string } }) => {
        const u = state.users.find((r) =>
          where.referralCode !== undefined ? r.referralCode === where.referralCode : r.username === where.username,
        );
        return u ? { ...u } : null;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const u = find(where.id);
        if (u.claimedAt) return { count: 0 };
        Object.assign(u, data);
        return { count: 1 };
      }),
    },
    bonusClaim: {
      findFirst: jest.fn(async ({ where }: { where: { OR: Array<{ kind: string; hmac: string }> } }) =>
        state.bonusClaims.find((c) => where.OR.some((o) => o.kind === c.kind && o.hmac === c.hmac)) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: { kind: string; hmac: string } }) => {
        if (failBonusCreateOnce || state.bonusClaims.some((c) => c.kind === data.kind && c.hmac === data.hmac)) {
          failBonusCreateOnce = false;
          throw Object.assign(new Error('dup'), { code: 'P2002' });
        }
        state.bonusClaims.push(data);
        return data;
      }),
    },
    referral: {
      count: jest.fn(
        async ({ where }: { where: { inviterId: string; outcome: string; createdAt: { gte: Date } } }) =>
          state.referrals.filter(
            (r) => r.inviterId === where.inviterId && r.outcome === where.outcome && r.createdAt >= where.createdAt.gte,
          ).length,
      ),
      create: jest.fn(async ({ data }: { data: { inviterId: string; inviteeId: string; outcome: string } }) => {
        const row = { id: `ref-${state.referrals.length + 1}`, createdAt: new Date(), ...data };
        state.referrals.push(row);
        return { id: row.id };
      }),
    },
    $queryRaw: jest.fn(async () => []),
  };
  const prisma = {
    ...client,
    $transaction: jest.fn(async (fn: (tx: typeof client) => Promise<unknown>) => {
      const snapshot = structuredClone(state);
      try {
        return await fn(client);
      } catch (err) {
        state.users = snapshot.users;
        state.bonusClaims = snapshot.bonusClaims;
        state.referrals = snapshot.referrals;
        throw err;
      }
    }),
  };
  const usernames = { assertAvailable: jest.fn(async (raw: string) => raw.trim().toLowerCase()) };
  const me = { view: jest.fn(async (id: string) => ({ id })) };
  const settings = { get: jest.fn(async () => ({ ...SETTINGS, ...opts.settings })) };
  const ledger = { post: jest.fn(async () => ({ replayed: false })) };
  const svc = new ClaimService(
    prisma as never,
    usernames as never,
    me as never,
    settings as never,
    hashes,
    ledger as never,
  );
  return {
    svc,
    state,
    ledger,
    failNextBonusCreate: () => {
      failBonusCreateOnce = true;
    },
    seedClaim: (kind: 'email' | 'install', value: string) =>
      state.bonusClaims.push({
        kind,
        hmac: hashes.hash(`bonus-${kind}`, kind === 'email' ? canonicalEmail(value) : value),
      }),
  };
}

const user = (status = 'active') => ({ id: 'u1', sessionId: 's1', deviceId: 'dev-1', status }) as never;

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'passed',
    (e: HttpException) => (e.getResponse() as { code: string }).code,
  );
}

describe('ClaimService', () => {
  it('grants the bonus once to a new email on a new install', async () => {
    const { svc, state, ledger } = build();
    const res = await svc.claim(user(), { username: 'Ann_1' });
    expect(res).toEqual({ user: { id: 'u1' }, bonus: { granted: true, credits: 100 }, referral: null });
    expect(state.bonusClaims.map((c) => c.kind).sort()).toEqual(['email', 'install']);
    expect(ledger.post).toHaveBeenCalledWith(
      { userId: 'u1', type: 'signup_bonus', amount: 100, reference: 'u1' },
      expect.anything(),
    );
    expect(state.users[0]).toMatchObject({ username: 'ann_1', claimedAt: expect.any(Date) });
  });

  it('gives nothing to an email that had a bonus before (delete and recreate)', async () => {
    const { svc, seedClaim, ledger, state } = build();
    seedClaim('email', 'ann@example.com');
    const res = await svc.claim(user(), { username: 'ann_1' });
    expect(res.bonus).toEqual({ granted: false, credits: 0, reason: 'BONUS_ALREADY_CLAIMED' });
    expect(ledger.post).not.toHaveBeenCalled();
    expect(state.users[0].username).toBe('ann_1');
  });

  it('gives nothing to a second account on the same install', async () => {
    const { svc, seedClaim } = build();
    seedClaim('install', 'dev-1');
    expect((await svc.claim(user(), { username: 'ann_1' })).bonus.reason).toBe('BONUS_ALREADY_CLAIMED');
  });

  it('treats Gmail dots and +tags as the same email', async () => {
    const { svc, seedClaim } = build({ email: 'a.nn+promo@gmail.com' });
    seedClaim('email', 'ann@gmail.com');
    expect((await svc.claim(user(), { username: 'ann_1' })).bonus.reason).toBe('BONUS_ALREADY_CLAIMED');
  });

  it('gives nothing past the per-IP signup limit, and records no claim', async () => {
    const { svc, state } = build({ ipLimited: true });
    expect((await svc.claim(user(), { username: 'ann_1' })).bonus).toEqual({
      granted: false,
      credits: 0,
      reason: 'IP_LIMIT_REACHED',
    });
    expect(state.bonusClaims).toHaveLength(0);
  });

  it('rewards both sides of a referral when the invitee is new', async () => {
    const { svc, ledger } = build();
    const res = await svc.claim(user(), { username: 'ann_1', referralCode: ' invite22 ' });
    expect(res.referral).toEqual({ outcome: 'rewarded', credits: 20 });
    expect(ledger.post).toHaveBeenCalledWith(
      { userId: 'u1', type: 'referral_invitee', amount: 20, reference: 'ref-1' },
      expect.anything(),
    );
    expect(ledger.post).toHaveBeenCalledWith(
      { userId: 'u2', type: 'referral_inviter', amount: 20, reference: 'ref-1' },
      expect.anything(),
    );
  });

  it('still rewards the invitee when the inviter is at the cap', async () => {
    const { svc, state, ledger } = build({ settings: { referralCapCount: 1 } });
    state.referrals.push({ id: 'old', inviterId: 'u2', inviteeId: 'x', outcome: 'rewarded', createdAt: new Date() });
    const res = await svc.claim(user(), { username: 'ann_1', referralCode: 'INVITE22' });
    expect(res.referral).toEqual({ outcome: 'inviter_capped', credits: 20 });
    expect(ledger.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'referral_inviter' }), expect.anything());
  });

  it('rewards nobody when the invitee is not new', async () => {
    const { svc, seedClaim, ledger } = build();
    seedClaim('install', 'dev-1');
    const res = await svc.claim(user(), { username: 'ann_1', referralCode: 'INVITE22' });
    expect(res.referral).toEqual({ outcome: 'invitee_ineligible', credits: 0 });
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it.each(['NOPE0000', 'SELFCODE', 'SUSPEND3'])('refuses the referral code %s, writing nothing', async (code) => {
    const { svc, state } = build();
    await expect(codeOf(svc.claim(user(), { username: 'ann_1', referralCode: code }))).resolves.toBe(
      'REFERRAL_CODE_INVALID',
    );
    expect(state.users[0].claimedAt).toBeNull();
  });

  it('falls back to no bonus when a parallel claim takes it first', async () => {
    const { svc, state, failNextBonusCreate, ledger } = build();
    failNextBonusCreate();
    const res = await svc.claim(user(), { username: 'ann_1' });
    expect(res.bonus).toEqual({ granted: false, credits: 0, reason: 'BONUS_ALREADY_CLAIMED' });
    expect(ledger.post).not.toHaveBeenCalled();
    expect(state.users[0]).toMatchObject({ username: 'ann_1', claimedAt: expect.any(Date) });
  });

  it('refuses a second claim and a suspended account', async () => {
    await expect(codeOf(build({ claimed: new Date() }).svc.claim(user(), { username: 'ann_1' }))).resolves.toBe(
      'ALREADY_CLAIMED',
    );
    await expect(codeOf(build().svc.claim(user('suspended'), { username: 'ann_1' }))).resolves.toBe(
      'ACCOUNT_SUSPENDED',
    );
  });
});
