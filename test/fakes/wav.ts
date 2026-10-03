/** One RIFF chunk: id, little-endian size, body, and a pad byte for odd sizes. */
export function riffChunk(id: string, body: Buffer, declaredSize = body.length): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(declaredSize, 4);
  return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

export interface WavOptions {
  seconds: number;
  sampleRate?: number;
  channels?: number;
  bits?: number;
  format?: number;
  /** For format 0xFFFE (extensible): the code in the SubFormat GUID. */
  subFormat?: number;
  extraChunks?: Buffer[];
  dataSizeOverride?: number;
  omitFmt?: boolean;
}

/** A WAV file of silence, built byte by byte. */
export function makeWav(o: WavOptions): Buffer {
  const sampleRate = o.sampleRate ?? 16_000;
  const channels = o.channels ?? 1;
  const bits = o.bits ?? 16;
  const blockAlign = (channels * bits) / 8;
  const extensible = o.format === 0xfffe;
  const fmt = Buffer.alloc(extensible ? 40 : 16);
  fmt.writeUInt16LE(o.format ?? 1, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bits, 14);
  if (extensible) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(bits, 18);
    fmt.writeUInt16LE(o.subFormat ?? 1, 24);
  }
  const pcm = Buffer.alloc(Math.round(o.seconds * sampleRate) * blockAlign);
  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    ...(o.omitFmt ? [] : [riffChunk('fmt ', fmt)]),
    ...(o.extraChunks ?? []),
    riffChunk('data', pcm, o.dataSizeOverride ?? pcm.length),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
