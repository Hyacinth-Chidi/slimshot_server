import { PricingMode } from '../../generated/prisma/enums';
import { type PricedRule, priceFor, tierProblems } from './pricing';

const tiers: PricedRule = {
  id: 'r1',
  version: 3,
  mode: PricingMode.duration_tiers,
  perJobCredits: null,
  tiers: [
    { upToSeconds: 60, credits: 2 },
    { upToSeconds: 180, credits: 5 },
    { upToSeconds: null, credits: 9 },
  ],
};

describe('priceFor', () => {
  it.each([
    [0.5, 2],
    [60, 2],
    [60.001, 5],
    [180, 5],
    [180.5, 9],
    [3_600, 9],
  ])('%p seconds costs %p credits', (seconds, credits) => {
    expect(priceFor(tiers, seconds)).toBe(credits);
  });

  it('charges a flat price per job', () => {
    expect(priceFor({ ...tiers, mode: PricingMode.per_job, perJobCredits: 4, tiers: null }, 999)).toBe(4);
  });
});

describe('tierProblems', () => {
  it('accepts ascending tiers ending open', () => {
    expect(tierProblems(tiers.tiers ?? [])).toEqual([]);
  });

  it.each([
    [[], 'At least one tier'],
    [[{ upToSeconds: 60, credits: 2 }], 'last tier must be open-ended'],
    [[{ upToSeconds: null, credits: 2 }, { upToSeconds: null, credits: 3 }], 'only the last tier can be open-ended'],
    [
      [
        { upToSeconds: 60, credits: 2 },
        { upToSeconds: 30, credits: 3 },
        { upToSeconds: null, credits: 4 },
      ],
      'greater than the tier before',
    ],
    [[{ upToSeconds: 60, credits: -1 }, { upToSeconds: null, credits: 4 }], 'credits must be a whole number'],
  ])('reports %j', (input, message) => {
    expect(tierProblems(input as never).join(' ')).toContain(message);
  });
});
