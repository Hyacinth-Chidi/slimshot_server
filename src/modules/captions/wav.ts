export class InvalidWavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWavError';
  }
}

const PCM = 1;
const IEEE_FLOAT = 3;
const EXTENSIBLE = 0xfffe;
const SAMPLE_BITS = new Set([8, 16, 24, 32, 64]);

/**
 * Bytes per second of uncompressed audio, from the fields a decoder plays it by. The
 * header's own byte-rate field is ignored: nothing decodes by it, so a forged one would
 * shrink the measured length without shortening what the provider transcribes.
 */
function bytesPerSecond(fmt: Buffer, size: number): number {
  let format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const blockAlign = fmt.readUInt16LE(12);
  const bits = fmt.readUInt16LE(14);
  if (format === EXTENSIBLE) {
    if (size < 40 || fmt.length < 40) throw new InvalidWavError('The WAV format header is incomplete.');
    format = fmt.readUInt16LE(24); // the first two bytes of the SubFormat GUID
  }
  if (format !== PCM && format !== IEEE_FLOAT) {
    throw new InvalidWavError('Only uncompressed PCM or float WAV is supported.');
  }
  if (channels < 1 || channels > 32 || sampleRate < 1_000 || sampleRate > 768_000 || !SAMPLE_BITS.has(bits)) {
    throw new InvalidWavError('The WAV format header has impossible values.');
  }
  if (blockAlign !== (channels * bits) / 8) {
    throw new InvalidWavError('The WAV format header does not add up.');
  }
  return sampleRate * blockAlign;
}

/**
 * Seconds of audio in an uncompressed WAV: data bytes ÷ (sample rate × block align).
 * The server prices captions from this, never from a number the app sends.
 */
export function wavDurationSeconds(audio: Buffer): number {
  if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new InvalidWavError('The upload is not a WAV file.');
  }
  let offset = 12;
  let byteRate: number | null = null;

  while (offset + 8 <= audio.length) {
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      if (size < 16 || body + 16 > audio.length) throw new InvalidWavError('The WAV format header is incomplete.');
      byteRate = bytesPerSecond(audio.subarray(body, body + size), size);
    } else if (id === 'data') {
      if (byteRate === null) throw new InvalidWavError('The WAV has no format chunk before its audio.');
      // A streaming writer may leave a placeholder size; an upload may be cut short. Count what is there.
      const bytes = Math.min(size, audio.length - body);
      if (bytes <= 0) throw new InvalidWavError('The WAV contains no audio.');
      return bytes / byteRate;
    }
    // Chunks are word-aligned: odd sizes carry one pad byte.
    offset = body + size + (size % 2);
  }
  throw new InvalidWavError('The WAV contains no audio.');
}
