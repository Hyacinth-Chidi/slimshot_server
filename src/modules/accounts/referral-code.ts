import { randomInt } from 'node:crypto';

// Crockford-style: no I, L, O, U, 0 or 1, so a code read aloud cannot be misheard.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export function newReferralCode(): string {
  return Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

export function normalizeReferralCode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}
