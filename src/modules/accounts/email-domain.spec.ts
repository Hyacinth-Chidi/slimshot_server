import { isDisposable } from './email-domain';

describe('isDisposable', () => {
  const list = ['mailinator.com', 'yopmail.com'];

  it.each([
    ['x@mailinator.com', true],
    ['x@eu.mailinator.com', true],
    ['x@YOPMAIL.com', true],
    ['x@gmail.com', false],
    ['x@notmailinator.com', false],
  ])('%s → %s', (email, expected) => {
    expect(isDisposable(email, list)).toBe(expected);
  });
});
