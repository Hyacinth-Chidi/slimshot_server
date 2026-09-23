import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'generated' || entry === 'node_modules') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('revealSecret call sites', () => {
  it('is called from exactly one place in src', () => {
    // revealSecret is the only path returning decrypted plaintext. A second
    // caller is a second thing to audit, and the point of a separate method is
    // that it cannot be reached by accident.
    const callers = walk(join(process.cwd(), 'src')).filter((f) => {
      const body = readFileSync(f, 'utf8');
      return (
        body.includes('.revealSecret(') && !f.endsWith('settings.service.ts')
      );
    });

    expect(callers.map((f) => f.replace(process.cwd(), ''))).toHaveLength(1);
  });
});
