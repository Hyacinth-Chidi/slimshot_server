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

  it.each([
    ['not RIFF', Buffer.from('OggS not a wav file at all')],
    ['not PCM', makeWav({ seconds: 1, format: 85 })],
    ['audio before its format', makeWav({ seconds: 1, omitFmt: true })],
    ['no audio', makeWav({ seconds: 0 })],
  ])('refuses %s', (_label, audio) => {
    expect(() => wavDurationSeconds(audio)).toThrow(InvalidWavError);
  });
});
