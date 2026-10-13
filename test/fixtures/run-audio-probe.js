// Runs probeAudio (src/core/storage/audio-probe.ts) on every fixture in plain
// Node and prints the results as JSON. audio-probe.spec.ts spawns this because
// music-metadata is ESM-only: Node's require() loads it, Jest's runtime cannot.
require('ts-node').register({ transpileOnly: true });

const { Readable } = require('node:stream');
const fixtures = require('./audio-fixtures');
const { probeAudio } = require('../../src/core/storage/audio-probe');

const cases = {
  wav: fixtures.wav(2.5),
  mp3: fixtures.mp3(100),
  flac: fixtures.flac(3),
  aac: fixtures.aac(200),
  ogg: fixtures.ogg(4),
  text: Buffer.from('this is a text file renamed to .mp3, not audio '.repeat(20)),
  flacWithoutLength: fixtures.flac(0),
  // 1 Hz mono: 200 kB of samples claims to be about 28 hours long.
  absurdlyLong: fixtures.wav(100_000, 1),
};

/** Valid WAV bytes, then the connection drops: a storage fault, not bad content. */
function droppedConnection() {
  const bytes = fixtures.wav(2.5);
  let sent = false;
  return {
    size: bytes.length,
    stream: new Readable({
      read() {
        if (sent) {
          this.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
          return;
        }
        sent = true;
        this.push(bytes.subarray(0, 64));
      },
    }),
  };
}

(async () => {
  const results = {};
  for (const [name, bytes] of Object.entries(cases)) {
    // A byte stream, like the body R2 returns (Readable.from defaults to object mode).
    const stream = Readable.from([bytes], { objectMode: false });
    try {
      results[name] = await probeAudio(stream, bytes.length);
    } catch (error) {
      results[name] = { error: error.name, message: error.message };
    }
  }
  const drop = droppedConnection();
  try {
    results.networkDrop = await probeAudio(drop.stream, drop.size);
  } catch (error) {
    results.networkDrop = { error: error.name, message: error.message };
  }
  process.stdout.write(JSON.stringify(results));
})();
