import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, type ReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackupStore } from './backup-store';

const CREDS = {
  accountId: '0123456789abcdef0123456789abcdef',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
};
const NAME = 'slimshot-20261029-031507-auto.dump';

/** Resolves once the store has closed the upload's file stream; times out if it never does. */
async function closed(body: ReadStream): Promise<void> {
  if (!body.closed) await once(body, 'close');
}

/** A stand-in S3 client: records commands, answers with whatever `reply` returns. */
function clientReturning(reply: (command: unknown) => unknown = () => ({})) {
  return { send: jest.fn(async (command: unknown) => reply(command)) };
}

describe('BackupStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'backup-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uploads under postgres/ with its size, a binary type and the metadata', async () => {
    const file = join(dir, 'x.partial');
    writeFileSync(file, 'hello world');
    const client = clientReturning();
    const store = new BackupStore(CREDS, 'slimshot-backups', client);

    expect(await store.upload(file, NAME, { trigger: 'auto' })).toEqual({ sizeBytes: 11 });

    const command = client.send.mock.calls[0][0] as PutObjectCommand;
    const { Body, ...rest } = command.input;
    await closed(Body as ReadStream);
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(rest).toEqual({
      Bucket: 'slimshot-backups',
      Key: `postgres/${NAME}`,
      ContentLength: 11,
      ContentType: 'application/octet-stream',
      Metadata: { trigger: 'auto' },
    });
    // Streamed from disk, never read into memory whole.
    expect((Body as ReadStream).path).toBe(file);
  });

  it('lets go of the file when the upload fails', async () => {
    const file = join(dir, 'x.partial');
    writeFileSync(file, 'hello world');
    const client = { send: jest.fn(async () => Promise.reject(new Error('R2 is unreachable'))) };
    const store = new BackupStore(CREDS, 'slimshot-backups', client);

    await expect(store.upload(file, NAME, { trigger: 'manual' })).rejects.toThrow('R2 is unreachable');

    const body = (client.send.mock.calls[0] as unknown as [PutObjectCommand])[0].input.Body as ReadStream;
    await closed(body);
    expect(body.destroyed).toBe(true);
  });

  it('lists every page newest first and ignores stray objects', async () => {
    const client = clientReturning((command) =>
      (command as ListObjectsV2Command).input.ContinuationToken === undefined
        ? {
            IsTruncated: true,
            NextContinuationToken: 'page-2',
            Contents: [
              { Key: 'postgres/slimshot-20261027-031501-auto.dump', Size: 100 },
              { Key: 'postgres/notes.txt', Size: 5 },
            ],
          }
        : {
            IsTruncated: false,
            Contents: [
              { Key: 'postgres/slimshot-20261029-120000-manual.dump', Size: 300 },
              { Key: 'postgres/slimshot-20261029.dump', Size: 7 },
              { Key: 'postgres/old/slimshot-20261026-031500-auto.dump', Size: 9 },
              { Key: 'postgres/slimshot-20261028-031502-auto.dump', Size: 200 },
            ],
          },
    );
    const store = new BackupStore(CREDS, 'slimshot-backups', client);

    expect(await store.list()).toEqual([
      {
        filename: 'slimshot-20261029-120000-manual.dump',
        sizeBytes: 300,
        createdAt: new Date('2026-10-29T12:00:00Z'),
        trigger: 'manual',
      },
      {
        filename: 'slimshot-20261028-031502-auto.dump',
        sizeBytes: 200,
        createdAt: new Date('2026-10-28T03:15:02Z'),
        trigger: 'auto',
      },
      {
        filename: 'slimshot-20261027-031501-auto.dump',
        sizeBytes: 100,
        createdAt: new Date('2026-10-27T03:15:01Z'),
        trigger: 'auto',
      },
    ]);
    const inputs = client.send.mock.calls.map(([c]) => (c as ListObjectsV2Command).input);
    expect(inputs).toEqual([
      { Bucket: 'slimshot-backups', Prefix: 'postgres/' },
      { Bucket: 'slimshot-backups', Prefix: 'postgres/', ContinuationToken: 'page-2' },
    ]);
  });

  it('presigns a download that saves under the backup name', async () => {
    const store = new BackupStore(CREDS, 'slimshot-backups', clientReturning());
    const before = Date.now();

    const { url, expiresAt } = await store.presignGet(NAME, 300);

    const parsed = new URL(url);
    expect(parsed.origin).toBe(`https://${CREDS.accountId}.r2.cloudflarestorage.com`);
    expect(decodeURIComponent(parsed.pathname)).toBe(`/slimshot-backups/postgres/${NAME}`);
    expect(parsed.searchParams.get('response-content-disposition')).toBe(`attachment; filename="${NAME}"`);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it('deletes one object by its full key', async () => {
    const client = clientReturning();
    const store = new BackupStore(CREDS, 'slimshot-backups', client);

    await store.delete(NAME);

    const command = client.send.mock.calls[0][0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({ Bucket: 'slimshot-backups', Key: `postgres/${NAME}` });
  });

  it('refuses a name that is not a backup, before it reaches R2', async () => {
    const client = clientReturning();
    const store = new BackupStore(CREDS, 'slimshot-backups', client);

    await expect(store.delete('../postgres/x')).rejects.toThrow('Not a backup name');
    await expect(store.presignGet('notes.txt', 300)).rejects.toThrow('Not a backup name');
    expect(client.send).not.toHaveBeenCalled();
  });
});
