import { canonicalEmail, emailDomain, normalizeEmail } from './email';

describe('email helpers', () => {
  it('normalises case and whitespace', () => {
    expect(normalizeEmail('  Ann@Example.COM ')).toBe('ann@example.com');
    expect(emailDomain('ann@mail.example.com')).toBe('mail.example.com');
  });

  it.each([
    ['ann+promo@example.com', 'ann@example.com'],
    ['A.nn+x@Gmail.com', 'ann@gmail.com'],
    ['a.n.n@googlemail.com', 'ann@gmail.com'],
    ['a.nn@example.com', 'a.nn@example.com'],
  ])('canonicalises %s for the bonus key', (input, expected) => {
    expect(canonicalEmail(input)).toBe(expected);
  });
});
