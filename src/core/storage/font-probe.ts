import * as fontkit from 'fontkit';
import type { Readable } from 'node:stream';

import { UnreadableUploadError } from './storage-adapter.interface';

export interface FontNames {
  /** Typographic family (name ID 16), else family (ID 1). */
  familyName: string;
  /** Typographic subfamily (ID 17), else subfamily (ID 2): Regular, Bold, SemiBold Italic… */
  styleName: string;
  /** Full name (ID 4). */
  fullName: string;
  /** PostScript name (ID 6), if the file has one. */
  postscriptName: string | null;
}

export interface FontProbe {
  format: 'ttf' | 'otf';
  mimeType: 'font/ttf' | 'font/otf';
  details: FontNames;
}

/** The parts of a fontkit font this module reads (its published types omit some of them). */
export interface FontkitFace {
  directory: { tables: Record<string, unknown> };
  variationAxes?: Record<string, unknown>;
  hasGlyphForCodePoint(codePoint: number): boolean;
  getName(key: string, lang?: string): string | null;
  familyName: string;
  subfamilyName: string;
  fullName: string;
  postscriptName: string | null;
}

/** Opens a single-face font file. */
export function openFont(bytes: Buffer): FontkitFace {
  return fontkit.create(bytes) as unknown as FontkitFace;
}

const COLOUR_TABLES = ['COLR', 'CBDT', 'sbix', 'SVG '];
const LATIN = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'].map((c) => c.codePointAt(0)!);

/** What the app's text engine can't use, or null for a font it can. */
export function fontProblem(info: {
  tables: string[];
  variable: boolean;
  hasGlyph: (codePoint: number) => boolean;
}): string | null {
  if (info.variable) return 'This is a variable font. Upload one static face (for example the Regular file).';
  if (info.tables.some((t) => COLOUR_TABLES.includes(t))) {
    return 'This is a colour or emoji font. Emoji in the app come from the phone, so only plain fonts are accepted.';
  }
  if (!LATIN.every((cp) => info.hasGlyph(cp))) {
    return 'This font is missing basic Latin letters (A–Z, a–z). Only Latin-script fonts are accepted.';
  }
  return null;
}

/** The format from the first four bytes; anything but a single TTF or OTF face is refused. */
function formatOf(head: Buffer): 'ttf' | 'otf' {
  const sig = head.subarray(0, 4).toString('latin1');
  if (sig === '\u0000\u0001\u0000\u0000' || sig === 'true') return 'ttf';
  if (sig === 'OTTO') return 'otf';
  if (sig === 'wOFF') throw new UnreadableUploadError('This is a WOFF web font. Upload the TTF or OTF file.');
  if (sig === 'wOF2') throw new UnreadableUploadError('This is a WOFF2 web font. Upload the TTF or OTF file.');
  if (sig === 'ttcf') throw new UnreadableUploadError('This is a font collection. Upload one face per file.');
  throw new UnreadableUploadError('The file is not a font (TTF or OTF).');
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** The whole file, read once: fonts are capped at a few megabytes. Stream errors pass through as themselves. */
export async function readFontFile(stream: Readable): Promise<Buffer> {
  try {
    return await readAll(stream);
  } finally {
    stream.destroy();
  }
}

/**
 * A font's real format and names, from its bytes. Refuses what the app's text
 * engine can't load: web fonts, collections, variable, colour and non-Latin
 * fonts, and damaged files.
 */
export function inspectFontBytes(bytes: Buffer): FontProbe {
  const format = formatOf(bytes);
  let details: FontNames;
  let problem: string | null;
  try {
    const font = openFont(bytes);
    problem = fontProblem({
      tables: Object.keys(font.directory.tables),
      variable: Object.keys(font.variationAxes ?? {}).length > 0,
      hasGlyph: (cp) => font.hasGlyphForCodePoint(cp),
    });
    details = {
      familyName: (font.getName('preferredFamily') ?? font.familyName ?? '').trim(),
      styleName: (font.getName('preferredSubfamily') ?? font.subfamilyName ?? '').trim() || 'Regular',
      fullName: (font.fullName ?? '').trim(),
      postscriptName: font.postscriptName?.trim() || null,
    };
  } catch {
    throw new UnreadableUploadError('The font file is damaged and could not be read.');
  }
  if (problem) throw new UnreadableUploadError(problem);
  if (!details.familyName) throw new UnreadableUploadError('The font file has no family name.');
  if (!details.fullName) details.fullName = `${details.familyName} ${details.styleName}`;
  return { format, mimeType: format === 'otf' ? 'font/otf' : 'font/ttf', details };
}

/** The ContentInspector for fonts. */
export async function probeFont(stream: Readable, _size: number): Promise<FontProbe> {
  return inspectFontBytes(await readFontFile(stream));
}
