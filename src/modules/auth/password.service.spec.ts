import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const svc = new PasswordService();

  it('verifies a correct password', async () => {
    const hash = await svc.hash('correct-horse-battery');
    await expect(svc.verify(hash, 'correct-horse-battery')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await svc.hash('correct-horse-battery');
    await expect(svc.verify(hash, 'wrong')).resolves.toBe(false);
  });

  it('never stores the plaintext in the hash', async () => {
    const hash = await svc.hash('correct-horse-battery');
    expect(hash).not.toContain('correct-horse-battery');
  });

  it('produces a different hash for the same password each time', async () => {
    const a = await svc.hash('same');
    const b = await svc.hash('same');
    expect(a).not.toBe(b);
    await expect(svc.verify(a, 'same')).resolves.toBe(true);
    await expect(svc.verify(b, 'same')).resolves.toBe(true);
  });

  it('uses argon2id', async () => {
    expect(await svc.hash('x')).toMatch(/^\$argon2id\$/);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(svc.verify('not-a-hash', 'x')).resolves.toBe(false);
  });
});
