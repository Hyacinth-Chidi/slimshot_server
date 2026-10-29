import { spawn } from 'node:child_process';

/** One pg_dump run. Everything secret travels in `env`, never in `args`. */
export interface PgDumpInvocation {
  command: 'pg_dump';
  args: string[];
  env: Record<string, string>;
}

/** The part of a child process runPgDump uses, so tests can stand in for pg_dump. */
export interface ChildProcessLike {
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnFn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => ChildProcessLike;

// libpq reads these from the environment. Prisma's own parameters (schema,
// connection_limit, pool_timeout…) mean nothing to pg_dump and are dropped.
const LIBPQ_PARAMS: Record<string, string> = {
  sslmode: 'PGSSLMODE',
  channel_binding: 'PGCHANNELBINDING',
  connect_timeout: 'PGCONNECT_TIMEOUT',
};

// pg_dump without --verbose says little; this only guards memory against a runaway.
const STDERR_READ = 64 * 1024;
const STDERR_KEPT = 2_000;

/**
 * The pg_dump command for DATABASE_URL, writing a custom-format archive to `outFile`.
 * The password goes in PGPASSWORD: command lines show in `ps` to anyone on the machine,
 * and in any error that quotes them.
 */
export function pgDumpInvocation(databaseUrl: string, outFile: string): PgDumpInvocation {
  const url = new URL(databaseUrl);
  const env: Record<string, string> = {};
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  for (const [param, variable] of Object.entries(LIBPQ_PARAMS)) {
    const value = url.searchParams.get(param);
    if (value) env[variable] = value;
  }
  return {
    command: 'pg_dump',
    args: [
      '--format=custom',
      '--no-owner',
      '--file',
      outFile,
      '--host',
      url.hostname,
      '--port',
      url.port || '5432',
      '--username',
      decodeURIComponent(url.username),
      '--dbname',
      decodeURIComponent(url.pathname.slice(1)),
    ],
    env,
  };
}

// stdin closed, so a missing password fails at once instead of waiting for someone to
// type it; stdout unused, since the archive goes to --file.
const spawnPgDump: SpawnFn = (cmd, args, opts) =>
  spawn(cmd, args, { env: opts.env, stdio: ['ignore', 'ignore', 'pipe'] });

/**
 * Runs pg_dump and settles when it ends: resolves on exit 0, otherwise rejects with what
 * pg_dump said, `secret` (by default the password) replaced by "[redacted]". Past
 * `timeoutMs` it kills pg_dump and rejects.
 */
export function runPgDump(
  inv: PgDumpInvocation,
  opts: { timeoutMs: number; spawn?: SpawnFn; secret?: string },
): Promise<void> {
  const secret = opts.secret ?? inv.env.PGPASSWORD;
  const scrub = (text: string) => (secret ? text.split(secret).join('[redacted]') : text);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    // pg_dump inherits the server's environment (PATH, locale) plus its own; nothing is read from it here.
    // eslint-disable-next-line no-restricted-properties
    const env = { ...process.env, ...inv.env };
    const child = (opts.spawn ?? spawnPgDump)(inv.command, inv.args, { env });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`The backup took longer than ${Math.round(opts.timeoutMs / 60_000)} minutes`));
    }, opts.timeoutMs);

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < STDERR_READ) stderr += chunk.toString();
    });
    child.on('error', (err) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      finish(new Error(missing ? 'pg_dump is not installed on this server' : scrub(err.message)));
    });
    child.on('close', (code) => {
      if (code === 0) return finish();
      const said = scrub(stderr).trim().slice(-STDERR_KEPT);
      finish(new Error(said || `pg_dump stopped with exit code ${code}`));
    });
  });
}
