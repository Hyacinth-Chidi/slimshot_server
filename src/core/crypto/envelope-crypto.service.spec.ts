import { EnvelopeCryptoService } from './envelope-crypto.service';

const KEY = 'a'.repeat(64); // 32 bytes hex

describe('EnvelopeCryptoService', () => {
  const svc = new EnvelopeCryptoService(KEY);

  it('round-trips a value', () => {
    const sealed = svc.encrypt('cloudinary-secret-123');
    expect(svc.decrypt(sealed)).toBe('cloudinary-secret-123');
  });

  it('never stores plaintext in the ciphertext buffer', () => {
    const sealed = svc.encrypt('cloudinary-secret-123');
    expect(sealed.cipher.toString('utf8')).not.toContain('cloudinary-secret-123');
  });

  it('produces different ciphertext each time for the same input', () => {
    const a = svc.encrypt('same');
    const b = svc.encrypt('same');
    expect(a.cipher.equals(b.cipher)).toBe(false);
    expect(svc.decrypt(a)).toBe(svc.decrypt(b));
  });

  it('stamps the key version', () => {
    expect(svc.encrypt('x').keyVersion).toBe(1);
  });

  it('rejects tampered ciphertext rather than returning garbage', () => {
    const sealed = svc.encrypt('secret');
    sealed.cipher[sealed.cipher.length - 1] ^= 0xff;
    expect(() => svc.decrypt(sealed)).toThrow();
  });

  it('refuses to construct with a key of the wrong length', () => {
    expect(() => new EnvelopeCryptoService('tooshort')).toThrow(/MASTER_ENCRYPTION_KEY/);
  });

  it('masks a secret for display without revealing it', () => {
    // Deliberately not shaped like any real provider's key prefix: secret
    // scanners match on the prefix alone and block the push on a fixture that
    // was never a credential.
    expect(svc.mask('tok_sample_abcdef1234')).toBe('tok_••••234');
  });

  it('fully masks a short secret', () => {
    expect(svc.mask('abc')).toBe('••••');
  });

  it.each([9, 10, 11, 12, 13, 16])(
    'never reveals more than a third of a %i-character secret',
    (len) => {
      const secret = 'A'.repeat(len - 4) + '1234';
      const masked = svc.mask(secret);
      const revealed = masked.replace(/•/g, '');
      expect(revealed.length).toBeLessThanOrEqual(Math.ceil(len / 3));
    },
  );

  it('does not let the revealed prefix and suffix overlap', () => {
    expect(svc.mask('AKIAABCD1234')).not.toBe('AKIAABCD••••1234');
    expect(svc.mask('AKIAABCD1234').replace(/•/g, '').length).toBeLessThan(12);
  });
});
