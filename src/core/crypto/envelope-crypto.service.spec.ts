import { EnvelopeCryptoService } from './envelope-crypto.service';

const KEY = 'a'.repeat(64); // 32 bytes hex

describe('EnvelopeCryptoService', () => {
  const svc = new EnvelopeCryptoService(KEY);

  it('round-trips a value', () => {
    const sealed = svc.encrypt('provider-key-123');
    expect(svc.decrypt(sealed)).toBe('provider-key-123');
  });

  it('never stores plaintext in the ciphertext', () => {
    const sealed = svc.encrypt('provider-key-123');
    expect(Buffer.from(sealed.cipher).toString('utf8')).not.toContain('provider-key-123');
  });

  it('produces different ciphertext each time for the same input', () => {
    const a = svc.encrypt('same');
    const b = svc.encrypt('same');
    expect(Buffer.from(a.cipher).equals(Buffer.from(b.cipher))).toBe(false);
    expect(svc.decrypt(a)).toBe(svc.decrypt(b));
  });

  it('decrypts bytes read back as a plain Uint8Array, the way Prisma returns Bytes', () => {
    const sealed = svc.encrypt('provider-key-123');
    const fromDb = new Uint8Array(sealed.cipher);
    expect(svc.decrypt({ cipher: fromDb, keyVersion: sealed.keyVersion })).toBe('provider-key-123');
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
});
