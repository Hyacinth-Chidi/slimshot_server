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
    expect(svc.mask('sk_live_abcdef123456')).toBe('sk_live_••••3456');
  });

  it('fully masks a short secret', () => {
    expect(svc.mask('abc')).toBe('••••');
  });
});
