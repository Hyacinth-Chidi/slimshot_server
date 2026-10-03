import { IdentityHashService } from './identity-hash.service';

describe('IdentityHashService', () => {
  const hashes = new IdentityHashService({ identityHmacSecret: 'h'.repeat(48) } as never);

  it('is stable, keyed by kind, and never contains the value', () => {
    const a = hashes.hash('email', 'ann@example.com');
    expect(a).toBe(hashes.hash('email', 'ann@example.com'));
    expect(a).not.toBe(hashes.hash('install', 'ann@example.com'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('depends on the secret', () => {
    const other = new IdentityHashService({ identityHmacSecret: 'x'.repeat(48) } as never);
    expect(other.hash('email', 'ann@example.com')).not.toBe(hashes.hash('email', 'ann@example.com'));
  });
});
