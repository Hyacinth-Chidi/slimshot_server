import { Readable } from 'node:stream';

import { probeImage } from './image-probe';
import { UnreadableUploadError } from './storage-adapter.interface';

const bytes = (...head: number[]) => Buffer.concat([Buffer.from(head), Buffer.alloc(64)]);
const stream = (b: Buffer) => Readable.from([b], { objectMode: false });
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(64)]);

describe('probeImage', () => {
  it.each([
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'image/png'],
    ['webp', webp, 'image/webp'],
  ])('recognises %s from its bytes', async (format, b, mimeType) => {
    await expect(probeImage(stream(b), b.length)).resolves.toEqual({ format, mimeType });
  });

  it('refuses anything else, whatever it is called', async () => {
    const gif = Buffer.from('GIF89a' + 'x'.repeat(64));
    await expect(probeImage(stream(gif), gif.length)).rejects.toBeInstanceOf(UnreadableUploadError);
  });

  it('refuses an empty file', async () => {
    await expect(probeImage(stream(Buffer.alloc(0)), 0)).rejects.toBeInstanceOf(UnreadableUploadError);
  });

  it('reads the signature across chunk boundaries', async () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const split = Readable.from([png.subarray(0, 3), png.subarray(3)], { objectMode: false });
    await expect(probeImage(split, png.length)).resolves.toEqual({ format: 'png', mimeType: 'image/png' });
  });

  it('lets a dropped connection through as itself', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('read ECONNRESET'));
      },
    });
    await expect(probeImage(broken, 100)).rejects.toThrow('read ECONNRESET');
  });
});
