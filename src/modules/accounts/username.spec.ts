import { normalizeUsername, usernameProblem } from './username';

describe('usernames', () => {
  it('trims and lowercases what the user typed', () => {
    expect(normalizeUsername('  Ann_1 ')).toBe('ann_1');
  });

  it.each([
    ['ann_1', null],
    ['abc', null],
    ['a'.repeat(20), null],
    ['ab', 'INVALID'],
    ['a'.repeat(21), 'INVALID'],
    ['ann-1', 'INVALID'],
    ['ann 1', 'INVALID'],
    ['admin', 'RESERVED'],
    ['slimshot', 'RESERVED'],
  ])('%s → %s', (name, problem) => {
    expect(usernameProblem(name)).toBe(problem);
  });
});
