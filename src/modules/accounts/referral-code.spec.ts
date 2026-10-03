import { newReferralCode, normalizeReferralCode } from './referral-code';

describe('referral codes', () => {
  it('are 8 unambiguous characters and do not repeat', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newReferralCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);
  });

  it('accept any case and stray spaces', () => {
    expect(normalizeReferralCode(' ab3d ef7k ')).toBe('AB3DEF7K');
  });
});
