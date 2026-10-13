import type { Readable } from 'node:stream';

import { UnreadableUploadError } from './storage-adapter.interface';

export interface AudioProbe {
  /** File extension without the dot, e.g. 'mp3'. */
  format: string;
  mimeType: string;
  durationMs: number;
}

/**
 * Longest track the catalogue accepts. Far above anything real (50 MB at 8 kbps
 * is under 14 hours), so a longer claim means a damaged header, and it keeps
 * the value inside the database's 32-bit column.
 */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * music-metadata's own errors for content it cannot parse. Anything else (a
 * dropped connection, a stream cut short, a bug in the parser) says nothing
 * about the file, and must not be reported as "not audio": that answer deletes
 * the upload.
 */
const CONTENT_ERRORS = new Set([
  'CouldNotDetermineFileTypeError',
  'UnsupportedFileTypeError',
  'UnexpectedFileContentError',
  'FieldDecodingError',
]);

/**
 * music-metadata's container name, mapped to what the catalogue stores. Only
 * the formats uploads accept are listed; anything else is refused. AAC arrives
 * as "ADTS/MPEG-4" or "ADTS/MPEG-2", so ADTS matches by prefix.
 */
function known(container: string | undefined): { format: string; mimeType: string } | undefined {
  switch (container) {
    case 'MPEG':
      return { format: 'mp3', mimeType: 'audio/mpeg' };
    case 'WAVE':
      return { format: 'wav', mimeType: 'audio/wav' };
    case 'FLAC':
      return { format: 'flac', mimeType: 'audio/flac' };
    case 'Ogg':
      return { format: 'ogg', mimeType: 'audio/ogg' };
    default:
      return container?.startsWith('ADTS') ? { format: 'aac', mimeType: 'audio/aac' } : undefined;
  }
}

/**
 * Reads an uploaded file's real format and duration from its bytes. R2 stores
 * whatever it is given, so this is what stops a renamed text file being
 * catalogued as audio, and what tells pricing and the app how long a track is.
 * The format is detected from the content, never the name.
 */
export async function probeAudio(stream: Readable, size: number): Promise<AudioProbe> {
  let container: string | undefined;
  let seconds: number | undefined;
  try {
    // ESM-only package: loading it here, not at the top of the file, keeps every
    // module that imports the storage layer loadable under Jest. Node's require()
    // loads it fine at run time.
    const { parseStream } = await import('music-metadata');
    // duration: true scans every MP3 frame, so a VBR file without a header still
    // gets an exact length instead of an estimate.
    const { format } = await parseStream(stream, { size }, { duration: true, skipCovers: true });
    container = format.container;
    seconds = format.duration;
  } catch (error) {
    if (CONTENT_ERRORS.has((error as Error)?.name)) {
      throw new UnreadableUploadError('The file is not a supported audio file (MP3, WAV, AAC, OGG or FLAC).');
    }
    throw error;
  } finally {
    stream.destroy();
  }

  const type = known(container);
  if (!type) {
    throw new UnreadableUploadError(
      `The file is ${container ?? 'an unknown format'}, not a supported audio file (MP3, WAV, AAC, OGG or FLAC).`,
    );
  }
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    throw new UnreadableUploadError('Could not read how long the audio is. The file may be damaged.');
  }

  const durationMs = Math.round(seconds * 1000);
  if (durationMs > MAX_DURATION_MS) {
    throw new UnreadableUploadError('The audio claims to be longer than 24 hours. The file looks damaged.');
  }

  return { ...type, durationMs };
}
