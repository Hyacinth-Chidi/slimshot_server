import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../..');
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');

/** The Dockerfile from `FROM … AS runtime` to the next FROM: what the API container has. */
function runtimeStage(text: string): string {
  const start = text.search(/^FROM\s+\S+\s+AS\s+runtime\s*$/im);
  if (start < 0) return '';
  const next = text.slice(start + 1).search(/^FROM\s/im);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

/** The client major the runtime stage installs: from the install line, never a comment. */
function clientMajor(text: string): number | null {
  const installs = runtimeStage(text)
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#') && line.includes('apt-get install'));
  const match = installs.map((line) => /\bpostgresql-client-(\d+)\b/.exec(line)).find(Boolean);
  return match ? Number(match[1]) : null;
}

describe('pg_dump in the API image', () => {
  it('reads the version from the install line, not from a comment', () => {
    const fixture = [
      'FROM node:24-bookworm-slim AS runtime',
      '# postgresql-client-17 is pg_dump for database backups.',
      'RUN apt-get update',
      '  && apt-get install -y --no-install-recommends postgresql-client-15',
      '  && rm -rf /var/lib/apt/lists/*',
    ].join('\n');
    expect(clientMajor(fixture)).toBe(15);
  });

  // pg_dump refuses to dump a server newer than itself: upgrading postgres in
  // docker-compose.yml without the client would quietly stop every backup.
  it('installs a client at least as new as the database, in the stage that runs the API', () => {
    const client = clientMajor(dockerfile);
    const server = /^\s*image:\s*postgres:(\d+)/m.exec(compose);
    expect(server).not.toBeNull();
    expect(client).not.toBeNull();
    expect(client!).toBeGreaterThanOrEqual(Number(server![1]));
  });

  it('takes the client from the PostgreSQL repository, signed by its key', () => {
    const stage = runtimeStage(dockerfile);
    expect(stage).toContain('https://www.postgresql.org/media/keys/ACCC4CF8.asc');
    expect(stage).toContain(
      'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt',
    );
  });
});
