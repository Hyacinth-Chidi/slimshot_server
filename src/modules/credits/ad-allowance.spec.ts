import { adsUsedToday, nextUtcMidnight, startOfUtcDay } from './ad-allowance';

describe('ad allowance', () => {
  it('uses UTC days', () => {
    const t = new Date('2026-10-03T23:30:00+01:00'); // 22:30 UTC
    expect(startOfUtcDay(t).toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(nextUtcMidnight(t).toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });

  it("counts today's rewarded ads for the user", async () => {
    const db = { creditTransaction: { count: jest.fn(async () => 3) } };
    await expect(adsUsedToday(db as never, 'u1', new Date('2026-10-03T12:00:00Z'))).resolves.toBe(3);
    expect(db.creditTransaction.count).toHaveBeenCalledWith({
      where: { userId: 'u1', type: 'rewarded_ad', createdAt: { gte: new Date('2026-10-03T00:00:00Z') } },
    });
  });
});
