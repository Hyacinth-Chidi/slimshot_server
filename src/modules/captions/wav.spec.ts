import { makeWav, riffChunk } from '../../../test/fakes/wav';
import { InvalidWavError, wavDurationSeconds } from './wav';

describe('wavDurationSeconds', () => {
  it('reads the duration of mono 16 kHz PCM', () => {
    expect(wavDurationSeconds(makeWav({ seconds: 2.5 }))).toBeCloseTo(2.5, 6);
  });

  it('reads other rates and channel counts', () => {
    expect(wavDurationSeconds(makeWav({ seconds: 1, sampleRate: 44_100, channels: 2 }))).toBeCloseTo(1, 6);
  });

  it('skips extra chunks, including odd-sized ones, before the audio', () => {
    const extra = [riffChunk('LIST', Buffer.alloc(5)), riffChunk('JUNK', Buffer.alloc(28))];
    expect(wavDurationSeconds(makeWav({ seconds: 3, extraChunks: extra }))).toBeCloseTo(3, 6);
  });

  it('measures the bytes present when a streaming writer left a placeholder size', () => {
    expect(wavDurationSeconds(makeWav({ seconds: 2, dataSizeOverride: 0xffffffff }))).toBeCloseTo(2, 6);
  });

  it('measures the bytes present when the upload was cut short', () => {
    const full = makeWav({ seconds: 4 });
    expect(wavDurationSeconds(full.subarray(0, full.length - 32_000))).toBeCloseTo(3, 6);
  });

  it('measures from the sample rate and block align, ignoring a forged byte rate', () => {
    const audio = makeWav({ seconds: 30 });
    audio.writeUInt32LE(0xffffffff, 28); // the fmt body starts at 20; byte rate is its third field
    expect(wavDurationSeconds(audio)).toBeCloseTo(30, 6);
  });

  it('reads extensible PCM and float audio', () => {
    expect(wavDurationSeconds(makeWav({ seconds: 2, format: 0xfffe, subFormat: 1 }))).toBeCloseTo(2, 6);
    expect(wavDurationSeconds(makeWav({ seconds: 2, format: 0xfffe, subFormat: 3, bits: 32 }))).toBeCloseTo(2, 6);
  });

  const patched = (offset: number, write: (b: Buffer) => void) => {
    const audio = makeWav({ seconds: 1 });
    write(audio.subarray(offset));
    return audio;
  };

  it.each([
    ['a block align that does not match its channels and bits', patched(32, (b) => b.writeUInt16LE(1, 0))],
    ['a zero sample rate', patched(24, (b) => b.writeUInt32LE(0, 0))],
    ['zero channels', patched(22, (b) => b.writeUInt16LE(0, 0))],
    ['an odd sample size', patched(34, (b) => b.writeUInt16LE(12, 0))],
    ['extensible audio that is not PCM', makeWav({ seconds: 1, format: 0xfffe, subFormat: 0x55 })],
  ])('refuses %s', (_label, audio) => {
    expect(() => wavDurationSeconds(audio)).toThrow(InvalidWavError);
  });

  it.each([
    ['not RIFF', Buffer.from('OggS not a wav file at all')],
    ['not PCM', makeWav({ seconds: 1, format: 85 })],
    ['audio before its format', makeWav({ seconds: 1, omitFmt: true })],
    ['no audio', makeWav({ seconds: 0 })],
  ])('refuses %s', (_label, audio) => {
    expect(() => wavDurationSeconds(audio)).toThrow(InvalidWavError);
  });
});
