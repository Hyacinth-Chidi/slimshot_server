import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * deploy/scripts/backup-db.sh and restore-db.sh, run for real by bash against stand-ins
 * for docker, curl and flock that log every call. No Docker or Postgres needed.
 */
const repo = join(__dirname, '../../..');
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';

const DOCKER = [
  '#!/usr/bin/env bash',
  'echo "docker $* | DATABASE_URL=${DATABASE_URL:-}" >> "$STUB_LOG"',
  'if [ -n "${STUB_FAIL:-}" ] && [[ "$*" == *"$STUB_FAIL"* ]]; then exit 1; fi',
  'if [ -n "${STUB_HUP_ON:-}" ] && [[ "$*" == *"$STUB_HUP_ON"* ]]; then kill -HUP "$PPID"; fi',
  'case "$*" in',
  '  *pg_restore*) cat > /dev/null ;;',
  '  *pg_dump*) echo PGDMP-DATA ;;',
  '  *"-d slimshot_restore "*_prisma_migrations*) printf "%s\\n" ${STUB_RESTORE_MIGRATIONS:-} ;;',
  '  *"-d slimshot "*_prisma_migrations*) printf "%s\\n" ${STUB_LIVE_MIGRATIONS:-} ;;',
  'esac',
  'exit 0',
].join('\n');

const CURL = [
  '#!/usr/bin/env bash',
  'echo "curl $*" >> "$STUB_LOG"',
  'case "$*" in *health/ready*) [ -n "${STUB_NOT_READY:-}" ] && exit 22 ;; esac',
  'while [ $# -gt 0 ]; do if [ "$1" = "-o" ] && [ "$2" != "/dev/null" ]; then echo PGDMP-DATA > "$2"; fi; shift; done',
  'exit 0',
].join('\n');

interface Sandbox {
  root: string;
  app: string;
  log: string;
  run: (script: string, args: string[], env?: Record<string, string>, input?: string) => { status: number | null; output: string; calls: string[] };
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'backup-scripts-'));
  const app = join(root, 'app');
  const bin = join(root, 'bin');
  const log = join(root, 'calls.log');
  mkdirSync(join(app, 'deploy', 'scripts'), { recursive: true });
  mkdirSync(bin);
  for (const script of ['backup-db.sh', 'restore-db.sh']) {
    cpSync(join(repo, 'deploy', 'scripts', script), join(app, 'deploy', 'scripts', script));
  }
  writeFileSync(join(app, '.env'), 'POSTGRES_PASSWORD=abc123\nPORT=2700\n');
  writeFileSync(join(app, 'docker-compose.yml'), '');
  for (const [name, body] of [['docker', DOCKER], ['curl', CURL], ['flock', '#!/usr/bin/env bash\nexit 0']]) {
    writeFileSync(join(bin, name), `${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(log, '');

  const run: Sandbox['run'] = (script, args, env = {}, input = '') => {
    const result = spawnSync('bash', [`deploy/scripts/${script}`, ...args], {
      cwd: app,
      input,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}`,
        STUB_LOG: log,
        BACKUP_DIR: join(root, 'local-backups'),
        ...env,
      },
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
    };
  };
  return { root, app, log, run };
}

const roots: string[] = [];
function setup(): Sandbox {
  const s = sandbox();
  roots.push(s.root);
  return s;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const MIGRATIONS = { STUB_LIVE_MIGRATIONS: 'm1 m2 m3', STUB_RESTORE_MIGRATIONS: 'm1 m2 m3' };
const index = (calls: string[], part: string) => calls.findIndex((c) => c.includes(part));

describe('backup-db.sh', () => {
  it('saves a safety copy and deletes nothing already in the folder', () => {
    const s = setup();
    const dir = join(s.root, 'local-backups');
    mkdirSync(dir);
    const old = join(dir, 'slimshot-20261005-031500.dump');
    writeFileSync(old, 'an old nightly dump');
    const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000);
    utimesSync(old, twentyDaysAgo, twentyDaysAgo);

    const { status, output } = s.run('backup-db.sh', []);

    expect(status).toBe(0);
    expect(existsSync(old)).toBe(true);
    expect(output).toMatch(/saved .*\.dump/);
  });
});

describe('restore-db.sh', () => {
  it('restores, checks, swaps and starts the API, in that order', () => {
    const s = setup();
    const dump = join(s.root, 'backup.dump');
    writeFileSync(dump, 'PGDMP-DATA');

    const { status, output, calls } = s.run('restore-db.sh', [dump], MIGRATIONS, 'RESTORE\n');

    expect(output).toContain('Restored from backup.dump');
    expect(status).toBe(0);
    const order = ['pg_restore', 'run --rm -e DATABASE_URL migrate', '_prisma_migrations', 'stop api', 'RENAME TO slimshot;', 'up -d --wait', 'health/ready'];
    const at = order.map((part) => index(calls, part));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The password reaches the migrate container through its environment, never its arguments.
    const migrate = calls[index(calls, 'migrate')];
    expect(migrate).toContain('DATABASE_URL=postgresql://slimshot:abc123@postgres:5432/slimshot_restore');
    expect(migrate.split(' | ')[0]).not.toContain('abc123');
  });

  it('refuses to swap in a restored database that lacks a migration the live one has', () => {
    const s = setup();
    const dump = join(s.root, 'backup.dump');
    writeFileSync(dump, 'PGDMP-DATA');

    const { status, output, calls } = s.run(
      'restore-db.sh',
      [dump],
      { STUB_LIVE_MIGRATIONS: 'm1 m2 m3', STUB_RESTORE_MIGRATIONS: 'm1 m2' },
      'RESTORE\n',
    );

    expect(status).not.toBe(0);
    expect(output).toContain('m3');
    expect(index(calls, 'stop api')).toBe(-1);
    expect(calls[calls.length - 1]).toContain('DROP DATABASE IF EXISTS slimshot_restore');
  });

  it('fails a rehearsal whose restored database lacks a migration', () => {
    const s = setup();
    const dump = join(s.root, 'backup.dump');
    writeFileSync(dump, 'PGDMP-DATA');

    const { status, output } = s.run('restore-db.sh', ['--check', dump], {
      STUB_LIVE_MIGRATIONS: 'm1 m2 m3',
      STUB_RESTORE_MIGRATIONS: 'm1',
    });

    expect(status).not.toBe(0);
    expect(output).not.toContain('restores and migrates cleanly');
  });

  it('puts the original back when the API is up but not ready on the restored database', () => {
    const s = setup();
    const dump = join(s.root, 'backup.dump');
    writeFileSync(dump, 'PGDMP-DATA');

    const { status, calls } = s.run('restore-db.sh', [dump], { ...MIGRATIONS, STUB_NOT_READY: '1' }, 'RESTORE\n');

    expect(status).not.toBe(0);
    const back = calls.find((c) => /ALTER DATABASE slimshot_before_restore_\d{8}_\d{6} RENAME TO slimshot;/.test(c));
    expect(back).toBeDefined();
  });

  it('starts the API again when the SSH session drops while it is stopped', () => {
    const s = setup();
    const dump = join(s.root, 'backup.dump');
    writeFileSync(dump, 'PGDMP-DATA');

    const { status, calls } = s.run('restore-db.sh', [dump], { ...MIGRATIONS, STUB_HUP_ON: 'stop api' }, 'RESTORE\n');

    expect(status).not.toBe(0);
    const stopped = index(calls, 'stop api');
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(calls.slice(stopped + 1).some((c) => c.includes('up -d api'))).toBe(true);
    // Nothing was renamed yet, and the half-built copy goes.
    expect(index(calls, 'RENAME TO')).toBe(-1);
    expect(calls.some((c) => c.includes('DROP DATABASE IF EXISTS slimshot_restore WITH (FORCE)'))).toBe(true);
  });
});
