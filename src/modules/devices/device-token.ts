import { createHash, randomBytes } from 'node:crypto';

/** 256 random bits, URL-safe: the app stores it and sends it as a bearer token. */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database keeps: a stolen table cannot be replayed as tokens. */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
