import { PricingMode } from '../../generated/prisma/enums';
import {
  blockProblems,
  characterBlockProblems,
  countCharacters,
  type PricedRule,
  priceFor,
  tierProblems,
} from './pricing';

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

describe('priceFor by the second', () => {
  const perSecond: PricedRule = {
    id: 'r5',
    version: 5,
    mode: PricingMode.per_second,
    perJobCredits: null,
    tiers: null,
    blockSeconds: 10,
    blockCredits: 1,
    minCredits: 2,
  };

  it.each([
    [3, 2], // one block is 1 credit, but the minimum is 2
    [60, 6], // exactly six blocks
    [61, 7], // a started block counts in full
    [300, 30],
    [60 + 1e-9, 6], // float noise from the WAV maths is not a started block
    [60.0004, 6], // measured to the millisecond
    [60.0006, 7],
  ])('%p seconds costs %p credits', (seconds, credits) => {
    expect(priceFor(perSecond, seconds)).toBe(credits);
  });

  it('charges exactly the blocks when there is no minimum', () => {
    expect(priceFor({ ...perSecond, minCredits: null }, 3)).toBe(1);
  });

  it('charges at least one block for any audio at all', () => {
    expect(priceFor({ ...perSecond, minCredits: null }, 0.0001)).toBe(1);
  });

  it('is free when a block costs nothing and there is no minimum', () => {
    expect(priceFor({ ...perSecond, blockCredits: 0, minCredits: null }, 120)).toBe(0);
  });
});

describe('blockProblems', () => {
  it('accepts a block rate with or without a minimum', () => {
    expect(blockProblems({ blockSeconds: 10, blockCredits: 1, minCredits: 2 })).toEqual([]);
    expect(blockProblems({ blockSeconds: 1, blockCredits: 0 })).toEqual([]);
  });

  it.each([
    [{ blockCredits: 1 }, 'blockSeconds must be a whole number from 1 to 86400'],
    [{ blockSeconds: 0, blockCredits: 1 }, 'blockSeconds must be a whole number from 1 to 86400'],
    [{ blockSeconds: 10 }, 'blockCredits must be a whole number ≥ 0'],
    [{ blockSeconds: 10, blockCredits: 1.5 }, 'blockCredits must be a whole number ≥ 0'],
    [{ blockSeconds: 10, blockCredits: 1, minCredits: -1 }, 'minCredits must be a whole number ≥ 0'],
  ])('reports %j', (input, message) => {
    expect(blockProblems(input).join(' ')).toContain(message);
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

describe('text to speech, priced by characters', () => {
  const byCharacters: PricedRule = {
    id: 'r9',
    version: 1,
    mode: PricingMode.per_characters,
    perJobCredits: null,
    tiers: null,
    blockCharacters: 200,
    blockCredits: 1,
    minCredits: 2,
  };

  it('per_characters charges per started block, at least the minimum', () => {
    expect(priceFor(byCharacters, 1)).toBe(2); // one block, raised to the minimum
    expect(priceFor(byCharacters, 200)).toBe(2);
    expect(priceFor(byCharacters, 401)).toBe(3); // three started blocks
    expect(priceFor({ ...byCharacters, minCredits: null }, 1)).toBe(1);
  });

  it('counts code points, not UTF-16 units', () => {
    // An emoji with a skin tone is two code points and four UTF-16 units; the
    // app counts runes, so the two sides agree only on code points.
    expect(countCharacters('  héllo 👍🏽  ')).toBe(8);
    expect(countCharacters('   ')).toBe(0);
  });

  it('a per-characters rate needs a block of 1–100000 characters', () => {
    expect(characterBlockProblems({ blockCharacters: 0, blockCredits: 1 })).not.toEqual([]);
    expect(characterBlockProblems({ blockCharacters: 100_001, blockCredits: 1 })).not.toEqual([]);
    expect(characterBlockProblems({ blockCharacters: 200, blockCredits: -1 })).not.toEqual([]);
    expect(characterBlockProblems({ blockCharacters: 200, blockCredits: 1, minCredits: 0 })).toEqual([]);
  });
});
