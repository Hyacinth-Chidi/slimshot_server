import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

type Result = { format: string; mimeType: string; durationMs: number } | { error: string; message: string };

/**
 * music-metadata is ESM-only, which Jest's CommonJS runtime cannot load, so the
 * real parser runs in a plain Node child process over byte-built fixtures
 * (test/fixtures/run-audio-probe.js) and this spec checks what it printed.
 */
describe('probeAudio (real parser, in a child process)', () => {
  let results: Record<string, Result>;

  beforeAll(() => {
    const runner = join(__dirname, '../../../test/fixtures/run-audio-probe.js');
    const out = execFileSync(process.execPath, [runner], { encoding: 'utf8', timeout: 60_000 });
    results = JSON.parse(out) as Record<string, Result>;
  }, 90_000);

  it.each([
    ['wav', 'wav', 'audio/wav', 2500],
    ['mp3', 'mp3', 'audio/mpeg', 2612],
    ['flac', 'flac', 'audio/flac', 3000],
    ['ogg', 'ogg', 'audio/ogg', 4000],
  ])('reads %s: format, MIME type and duration from the bytes', (name, format, mimeType, durationMs) => {
    expect(results[name]).toEqual({ format, mimeType, durationMs });
  });

  it('reads AAC in ADTS frames, with the duration to within a frame or two', () => {
    // 200 frames of 1024 samples at 44.1 kHz is 4644 ms; ADTS has no length
    // field, so the parser estimates from the bitrate.
    expect(results.aac).toMatchObject({ format: 'aac', mimeType: 'audio/aac' });
    expect((results.aac as { durationMs: number }).durationMs).toBeGreaterThan(4500);
    expect((results.aac as { durationMs: number }).durationMs).toBeLessThan(4700);
  });

  it('refuses a file that is not audio, whatever its name says', () => {
    expect(results.text).toEqual({
      error: 'UnreadableUploadError',
      message: expect.stringMatching(/not a supported audio file/i),
    });
  });

  it('refuses a damaged file claiming an impossible length, before it overflows the catalogue', () => {
    expect(results.absurdlyLong).toEqual({
      error: 'UnreadableUploadError',
      message: expect.stringMatching(/longer than 24 hours/i),
    });
  });

  it('lets a dropped connection through as a storage error, never as "not audio"', () => {
    // UnreadableUploadError makes finalize delete the file: a network fault
    // while reading a good upload must not cost the admin their upload.
    expect(results.networkDrop).toEqual({ error: 'Error', message: 'read ECONNRESET' });
  });

  it('refuses audio whose length cannot be read, since pricing and the app need it', () => {
    expect(results.flacWithoutLength).toEqual({
      error: 'UnreadableUploadError',
      message: expect.stringMatching(/how long/i),
    });
  });
});
