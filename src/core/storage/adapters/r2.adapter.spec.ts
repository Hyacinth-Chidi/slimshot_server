import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

import { UnreadableUploadError, type R2Config } from '../storage-adapter.interface';
import { R2Adapter } from './r2.adapter';

const CONFIG: R2Config = {
  accountId: '0123456789abcdef0123456789abcdef',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'slimshot-audio',
  publicBaseUrl: 'https://cdn.example.com',
};

const INPUT = {
  folder: 'slimshot/audio',
  filename: 'Data_Loading.MP3',
  mimeType: 'audio/mpeg',
  byteSize: 812_340,
  ttlSeconds: 900,
};

/** A stand-in S3 client: records commands, answers with whatever `reply` returns. */
function clientReturning(reply: (command: unknown) => unknown) {
  return { send: jest.fn(async (command: unknown) => reply(command)) };
}

describe('R2Adapter.createUploadTicket', () => {
  // The real AWS signer with fake credentials: no network, but exactly what R2 checks.
  const adapter = new R2Adapter('prov-r2', CONFIG);

  it('presigns a PUT to the bucket on the account endpoint, under a fresh key', async () => {
    const ticket = await adapter.createUploadTicket(INPUT);
    const url = new URL(ticket.uploadUrl);

    expect(ticket.method).toBe('PUT');
    expect(url.origin).toBe(`https://${CONFIG.accountId}.r2.cloudflarestorage.com`);
    expect(ticket.storageKey).toMatch(/^slimshot\/audio\/[0-9a-f-]{36}\.mp3$/);
    expect(decodeURIComponent(url.pathname)).toBe(`/slimshot-audio/${ticket.storageKey}`);
  });

  it('signs the size and the type, so R2 refuses any other body', async () => {
    const ticket = await adapter.createUploadTicket(INPUT);
    const signed = new URL(ticket.uploadUrl).searchParams.get('X-Amz-SignedHeaders')?.split(';');

    expect(signed).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host']));
    // The browser must send the same type it was signed for; it sets the length itself.
    expect(ticket.headers['Content-Type']).toBe('audio/mpeg');
  });

  it('adds no checksum the browser cannot compute', async () => {
    // AWS SDK default: a CRC32 of an empty body is signed into the URL, which
    // makes every real upload fail. The client is built with WHEN_REQUIRED.
    const params = new URL((await adapter.createUploadTicket(INPUT)).uploadUrl).searchParams;
    expect([...params.keys()].filter((k) => /checksum/i.test(k))).toEqual([]);
  });

  it('expires when the ticket says, and R2 enforces it', async () => {
    const before = Date.now();
    const ticket = await adapter.createUploadTicket(INPUT);
    expect(new URL(ticket.uploadUrl).searchParams.get('X-Amz-Expires')).toBe('900');
    expect(ticket.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 900_000);
    expect(ticket.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 900_000);
  });

  it('is create-only: once the file exists, the same URL cannot replace it', async () => {
    // Without this a leaked URL could swap a checked, catalogued file for any
    // bytes of the same size and type until the URL expires. R2 answers 412.
    const ticket = await adapter.createUploadTicket(INPUT);
    const signed = new URL(ticket.uploadUrl).searchParams.get('X-Amz-SignedHeaders')?.split(';');
    expect(signed).toContain('if-none-match');
    expect(ticket.headers['If-None-Match']).toBe('*');
  });

  it('never reuses a key, so an upload cannot replace an existing file', async () => {
    const [a, b] = await Promise.all([adapter.createUploadTicket(INPUT), adapter.createUploadTicket(INPUT)]);
    expect(a.storageKey).not.toBe(b.storageKey);
  });

  it('keeps only a plain extension from the file name', async () => {
    for (const filename of ['no-extension', 'evil.mp3/../../x', 'weird.m p3', 'track.toolongext']) {
      const { storageKey } = await adapter.createUploadTicket({ ...INPUT, filename });
      expect(storageKey).toMatch(/^slimshot\/audio\/[0-9a-f-]{36}$/);
    }
  });
});

describe('R2Adapter.verifyUpload', () => {
  it('reads the size from R2 and the format and length from the bytes', async () => {
    const body = Readable.from([Buffer.from('audio')], { objectMode: false });
    const client = clientReturning(() => ({ Body: body, ContentLength: 812_340 }));
    const probe = jest.fn(async () => ({ format: 'mp3', mimeType: 'audio/mpeg', durationMs: 145_200 }));
    const adapter = new R2Adapter('prov-r2', CONFIG, { client });

    const remote = await adapter.verifyUpload('slimshot/audio/abc.mp3', probe);

    const command = client.send.mock.calls[0][0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: 'slimshot-audio', Key: 'slimshot/audio/abc.mp3' });
    expect(probe).toHaveBeenCalledWith(body, 812_340);
    expect(remote).toEqual({
      storageKey: 'slimshot/audio/abc.mp3',
      byteSize: 812_340,
      format: 'mp3',
      mimeType: 'audio/mpeg',
      durationMs: 145_200,
      deliveryUrl: 'https://cdn.example.com/slimshot/audio/abc.mp3',
    });
  });

  it('leaves out the duration for content that has none, such as a cover', async () => {
    const client = clientReturning(() => ({ Body: Readable.from([Buffer.from('png')], { objectMode: false }), ContentLength: 3 }));
    const inspect = jest.fn(async () => ({ format: 'png', mimeType: 'image/png' }));
    const adapter = new R2Adapter('prov-r2', CONFIG, { client });

    const remote = await adapter.verifyUpload('slimshot/covers/c.png', inspect);

    expect(remote).toEqual({
      storageKey: 'slimshot/covers/c.png',
      byteSize: 3,
      format: 'png',
      mimeType: 'image/png',
      deliveryUrl: 'https://cdn.example.com/slimshot/covers/c.png',
    });
  });

  it('says the file is missing when nothing was uploaded under the key', async () => {
    const client = clientReturning(() => {
      throw Object.assign(new Error('The specified key does not exist.'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
    });
    const adapter = new R2Adapter('prov-r2', CONFIG, { client });

    await expect(adapter.verifyUpload('slimshot/audio/missing.mp3', jest.fn())).rejects.toThrow(
      'Uploaded object not found in storage: slimshot/audio/missing.mp3',
    );
  });

  it('passes on the probe refusing the content', async () => {
    const client = clientReturning(() => ({ Body: Readable.from([]), ContentLength: 10 }));
    const probe = jest.fn(async () => {
      throw new UnreadableUploadError('The file is not a supported audio file.');
    });
    const adapter = new R2Adapter('prov-r2', CONFIG, { client });

    await expect(adapter.verifyUpload('slimshot/audio/x.mp3', probe)).rejects.toBeInstanceOf(UnreadableUploadError);
  });

  it('lets storage outages through as they are, not as "missing"', async () => {
    const client = clientReturning(() => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'Error' });
    });
    const adapter = new R2Adapter('prov-r2', CONFIG, { client });
    await expect(adapter.verifyUpload('slimshot/audio/x.mp3', jest.fn())).rejects.toThrow('getaddrinfo ENOTFOUND');
  });
});

describe('R2Adapter delivery and deletion', () => {
  it('serves files from the public domain, escaping each part of the key', () => {
    const adapter = new R2Adapter('prov-r2', CONFIG);
    expect(adapter.getDeliveryUrl('slimshot/audio/a b#1.mp3')).toBe(
      'https://cdn.example.com/slimshot/audio/a%20b%231.mp3',
    );
  });

  it('presigns a time-limited GET for private reads', async () => {
    const adapter = new R2Adapter('prov-r2', CONFIG);
    const url = new URL(await adapter.getSignedUrl('slimshot/audio/abc.mp3', 300));
    expect(url.pathname).toBe('/slimshot-audio/slimshot/audio/abc.mp3');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('deletes the object by key', async () => {
    const client = clientReturning(() => ({}));
    const adapter = new R2Adapter('prov-r2', CONFIG, { client });
    await adapter.delete('slimshot/audio/abc.mp3');

    const command = client.send.mock.calls[0][0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({ Bucket: 'slimshot-audio', Key: 'slimshot/audio/abc.mp3' });
  });
});
