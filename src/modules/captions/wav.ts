export class InvalidWavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWavError';
  }
}

const PCM = 1;
const EXTENSIBLE = 0xfffe;

/**
 * Seconds of audio in a PCM WAV, from its header: data bytes ÷ byte rate.
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
      const format = audio.readUInt16LE(body);
      if (format !== PCM && format !== EXTENSIBLE) throw new InvalidWavError('Only uncompressed PCM WAV is supported.');
      byteRate = audio.readUInt32LE(body + 8);
      if (byteRate === 0) throw new InvalidWavError('The WAV header has a zero byte rate.');
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
