/**
 * Tiny, valid audio files built byte by byte, one per accepted format, so tests
 * exercise the real parser without binary fixtures in the repo. The audio is
 * silence or zeros: only the headers and frame structure matter for format and
 * duration.
 */

class BitWriter {
  private readonly bytes: number[] = [];
  private current = 0;
  private filled = 0;

  write(value: number | bigint, bits: number): this {
    const v = BigInt(value);
    for (let i = bits - 1; i >= 0; i--) {
      this.current = (this.current << 1) | Number((v >> BigInt(i)) & 1n);
      if (++this.filled === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.filled = 0;
      }
    }
    return this;
  }

  toBuffer(): Buffer {
    if (this.filled !== 0) throw new Error('BitWriter: not byte aligned');
    return Buffer.from(this.bytes);
  }
}

/** 16-bit PCM WAV of silence. */
export function wav(seconds: number, sampleRate = 8000, channels = 1): Buffer {
  const blockAlign = channels * 2;
  const dataBytes = Math.round(seconds * sampleRate) * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, constant bitrate: 1152 samples per frame. */
export function mp3(frames: number): Buffer {
  const frameLength = Math.floor((144 * 128_000) / 44_100); // 417 bytes, no padding
  const frame = Buffer.alloc(frameLength);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

/** FLAC with only a STREAMINFO block: the duration is total samples / sample rate. */
export function flac(seconds: number, sampleRate = 44_100): Buffer {
  const streamInfo = new BitWriter()
    .write(4096, 16) // min block size
    .write(4096, 16) // max block size
    .write(0, 24) // min frame size (unknown)
    .write(0, 24) // max frame size (unknown)
    .write(sampleRate, 20)
    .write(1, 3) // channels - 1
    .write(15, 5) // bits per sample - 1
    .write(Math.round(seconds * sampleRate), 36) // total samples
    .write(0n, 128) // MD5 of the audio (unset)
    .toBuffer();
  const blockHeader = Buffer.from([0x80, 0x00, 0x00, streamInfo.length]); // last block, STREAMINFO
  return Buffer.concat([Buffer.from('fLaC', 'ascii'), blockHeader, streamInfo]);
}

/** AAC-LC in ADTS frames, 44.1 kHz stereo: 1024 samples per frame. */
export function aac(frames: number): Buffer {
  const payload = 100;
  const frameLength = 7 + payload;
  const header = new BitWriter()
    .write(0xfff, 12) // sync
    .write(0, 1) // MPEG-4
    .write(0, 2) // layer
    .write(1, 1) // no CRC
    .write(1, 2) // profile: AAC LC
    .write(4, 4) // 44.1 kHz
    .write(0, 1) // private
    .write(2, 3) // channels
    .write(0, 4) // original, home, copyright bits
    .write(frameLength, 13)
    .write(0x7ff, 11) // buffer fullness: variable
    .write(0, 2) // one raw data block
    .toBuffer();
  const frame = Buffer.concat([header, Buffer.alloc(payload)]);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

function crc32Ogg(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
  }
  return crc >>> 0;
}

function oggPage(packet: Buffer, flags: number, granule: bigint, sequence: number): Buffer {
  const segments: number[] = [];
  let left = packet.length;
  while (left >= 255) {
    segments.push(255);
    left -= 255;
  }
  segments.push(left);
  const header = Buffer.alloc(27 + segments.length);
  header.write('OggS', 0, 'ascii');
  header.writeUInt8(0, 4);
  header.writeUInt8(flags, 5);
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(1234, 14); // stream serial number
  header.writeUInt32LE(sequence, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt8(segments.length, 26);
  Buffer.from(segments).copy(header, 27);
  const page = Buffer.concat([header, packet]);
  page.writeUInt32LE(crc32Ogg(page), 22);
  return page;
}

/** Ogg Vorbis headers and one audio page whose granule position sets the length. */
export function ogg(seconds: number, sampleRate = 44_100): Buffer {
  const identification = Buffer.alloc(30);
  identification.writeUInt8(1, 0);
  identification.write('vorbis', 1, 'ascii');
  identification.writeUInt32LE(0, 7); // version
  identification.writeUInt8(2, 11); // channels
  identification.writeUInt32LE(sampleRate, 12);
  identification.writeInt32LE(0, 16); // bitrate maximum
  identification.writeInt32LE(128_000, 20); // bitrate nominal
  identification.writeInt32LE(0, 24); // bitrate minimum
  identification.writeUInt8(0xb8, 28); // block sizes 256 / 2048
  identification.writeUInt8(1, 29); // framing

  const vendor = 'slimshot-test';
  const comment = Buffer.alloc(7 + 4 + vendor.length + 4 + 1);
  comment.writeUInt8(3, 0);
  comment.write('vorbis', 1, 'ascii');
  comment.writeUInt32LE(vendor.length, 7);
  comment.write(vendor, 11, 'ascii');
  comment.writeUInt32LE(0, 11 + vendor.length); // no user comments
  comment.writeUInt8(1, 15 + vendor.length); // framing

  const samples = BigInt(Math.round(seconds * sampleRate));
  return Buffer.concat([
    oggPage(identification, 0x02, 0n, 0), // beginning of stream
    oggPage(comment, 0x00, 0n, 1),
    oggPage(Buffer.alloc(64), 0x04, samples, 2), // end of stream
  ]);
}
