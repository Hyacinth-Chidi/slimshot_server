import type { Readable } from 'node:stream';

import { UnreadableUploadError } from './storage-adapter.interface';

const HEAD_BYTES = 12;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The first `n` bytes of a stream (fewer if it ends sooner). Stream errors propagate as themselves. */
async function readHead(stream: Readable, n: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    chunks.push(b);
    total += b.length;
    if (total >= n) break;
  }
  return Buffer.concat(chunks).subarray(0, n);
}

function detect(head: Buffer): { format: string; mimeType: string } | undefined {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { format: 'jpeg', mimeType: 'image/jpeg' };
  }
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { format: 'png', mimeType: 'image/png' };
  }
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
    return { format: 'webp', mimeType: 'image/webp' };
  }
  return undefined;
}

/**
 * A cover's real type, from its first bytes, never its name. Only JPEG, PNG
 * and WebP are accepted: what every Android image loader decodes.
 */
export async function probeImage(stream: Readable, size: number): Promise<{ format: string; mimeType: string }> {
  try {
    const head = size > 0 ? await readHead(stream, HEAD_BYTES) : Buffer.alloc(0);
    const type = detect(head);
    if (!type) throw new UnreadableUploadError('The file is not a supported image (JPEG, PNG or WebP).');
    return type;
  } finally {
    stream.destroy();
  }
}
