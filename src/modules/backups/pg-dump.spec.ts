import { EventEmitter } from 'node:events';

import { type ChildProcessLike, pgDumpInvocation, runPgDump } from './pg-dump';

const URL_WITH_EVERYTHING =
  'postgresql://slimshot:p%40ss@postgres:5432/slimshot?schema=public&connection_limit=5&sslmode=require';

describe('pgDumpInvocation', () => {
  it('passes the connection as arguments and the password only in the environment', () => {
    const inv = pgDumpInvocation(URL_WITH_EVERYTHING, '/tmp/x.partial');
    expect(inv.command).toBe('pg_dump');
    expect(inv.args).toEqual([
      '--format=custom',
      '--no-owner',
      '--file',
      '/tmp/x.partial',
      '--host',
      'postgres',
      '--port',
      '5432',
      '--username',
      'slimshot',
      '--dbname',
      'slimshot',
    ]);
    expect(inv.env).toEqual({ PGPASSWORD: 'p@ss', PGSSLMODE: 'require' });
    expect(inv.args.join(' ')).not.toContain('p@ss');
    expect(inv.args.join(' ')).not.toContain('p%40ss');
  });

  it('keeps the libpq settings pg_dump understands and drops Prisma’s own', () => {
    const inv = pgDumpInvocation(
      'postgresql://u:pw@db/app?channel_binding=require&connect_timeout=10&pool_timeout=3&schema=x',
      '/f',
    );
    expect(inv.env).toEqual({ PGPASSWORD: 'pw', PGCHANNELBINDING: 'require', PGCONNECT_TIMEOUT: '10' });
  });

  it('uses the default port when the address has none', () => {
    expect(pgDumpInvocation('postgresql://u:pw@db/app', '/f').args).toContain('5432');
  });
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    kill: jest.fn(() => true),
  });
  return { child, spawn: jest.fn(() => child as unknown as ChildProcessLike) };
}

describe('runPgDump', () => {
  const inv = pgDumpInvocation('postgresql://u:pw@db/app', '/f');
  const TIMEOUT = 30 * 60_000;

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves when pg_dump exits 0, and stops its clock', async () => {
    jest.useFakeTimers();
    process.env.SLIMSHOT_SPAWN_MARK = 'kept';
    const { child, spawn } = fakeChild();
    const done = runPgDump(inv, { timeoutMs: TIMEOUT, spawn });
    child.emit('close', 0);
    await expect(done).resolves.toBeUndefined();

    const [command, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(command).toBe('pg_dump');
    expect(args).toEqual(inv.args);
    expect(opts.env).toMatchObject({ PGPASSWORD: 'pw', SLIMSHOT_SPAWN_MARK: 'kept' });
    jest.advanceTimersByTime(TIMEOUT);
    expect(child.kill).not.toHaveBeenCalled();
    delete process.env.SLIMSHOT_SPAWN_MARK;
  });

  it('rejects with what pg_dump said, the password scrubbed, when it exits non-zero', async () => {
    const { child, spawn } = fakeChild();
    const done = runPgDump(inv, { timeoutMs: TIMEOUT, spawn });
    child.stderr.emit('data', Buffer.from('pg_dump: error: FATAL:  password authentication failed (pw)\n'));
    child.emit('close', 1);
    const err = (await done.catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('pg_dump: error: FATAL:  password authentication failed ([redacted])');
  });

  it('rejects with the exit code when pg_dump says nothing', async () => {
    const { child, spawn } = fakeChild();
    const done = runPgDump(inv, { timeoutMs: TIMEOUT, spawn });
    child.emit('close', 3);
    await expect(done).rejects.toThrow('pg_dump stopped with exit code 3');
  });

  it('says pg_dump is not installed when it cannot be started', async () => {
    const { child, spawn } = fakeChild();
    const done = runPgDump(inv, { timeoutMs: TIMEOUT, spawn });
    child.emit('error', Object.assign(new Error('spawn pg_dump ENOENT'), { code: 'ENOENT' }));
    child.emit('close', -2);
    await expect(done).rejects.toThrow('pg_dump is not installed on this server');
  });

  it('kills pg_dump after 30 minutes and says so', async () => {
    jest.useFakeTimers();
    const { child, spawn } = fakeChild();
    const done = runPgDump(inv, { timeoutMs: TIMEOUT, spawn });
    jest.advanceTimersByTime(TIMEOUT - 1);
    expect(child.kill).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalled();
    await expect(done).rejects.toThrow('The backup took longer than 30 minutes');
  });
});
