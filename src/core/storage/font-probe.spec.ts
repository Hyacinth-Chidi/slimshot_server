import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { fontProblem, probeFont } from './font-probe';
import { UnreadableUploadError } from './storage-adapter.interface';

const FONTS = join(__dirname, '../../../test/fixtures/fonts');
const file = (name: string) => readFileSync(join(FONTS, name));
const stream = (b: Buffer) => Readable.from([b], { objectMode: false });
const head = (sig: string) => Buffer.concat([Buffer.from(sig, 'latin1'), Buffer.alloc(200)]);

describe('probeFont', () => {
  it('reads Lato Regular: format and the names inside the file', async () => {
    const lato = file('Lato-Regular.ttf');
    await expect(probeFont(stream(lato), lato.length)).resolves.toEqual({
      format: 'ttf',
      mimeType: 'font/ttf',
      details: { familyName: 'Lato', styleName: 'Regular', fullName: 'Lato Regular', postscriptName: 'Lato-Regular' },
    });
  });

  it('reads an OTF', async () => {
    const otf = file('SourceSerif4-Regular.otf');
    await expect(probeFont(stream(otf), otf.length)).resolves.toMatchObject({
      format: 'otf',
      mimeType: 'font/otf',
      details: { familyName: 'Source Serif 4', styleName: 'Regular' },
    });
  });

  it.each([
    ['wOFF', /WOFF/],
    ['wOF2', /WOFF2/],
    ['ttcf', /collection/i],
  ])('refuses a %s file by its signature', async (sig, message) => {
    const bytes = head(sig);
    const error = await probeFont(stream(bytes), bytes.length).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnreadableUploadError);
    expect((error as Error).message).toMatch(message);
  });

  it('refuses bytes that are not a font, whatever the name says', async () => {
    const bytes = Buffer.from('this is a text file renamed to .ttf '.repeat(20));
    await expect(probeFont(stream(bytes), bytes.length)).rejects.toBeInstanceOf(UnreadableUploadError);
  });

  it('refuses a damaged font that starts like one', async () => {
    const bytes = head('\u0000\u0001\u0000\u0000');
    await expect(probeFont(stream(bytes), bytes.length)).rejects.toBeInstanceOf(UnreadableUploadError);
  });

  it('lets a dropped connection through as itself, never as "not a font"', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('read ECONNRESET'));
      },
    });
    await expect(probeFont(broken, 1000)).rejects.toThrow('read ECONNRESET');
  });
});

describe('fontProblem', () => {
  const clean = { tables: ['glyf', 'cmap', 'name'], variable: false, hasGlyph: () => true };

  it('accepts a static Latin font', () => {
    expect(fontProblem(clean)).toBeNull();
  });

  it('refuses a variable font', () => {
    expect(fontProblem({ ...clean, variable: true })).toMatch(/variable/i);
  });

  it.each(['COLR', 'CBDT', 'sbix', 'SVG '])('refuses a colour font (%s table)', (table) => {
    expect(fontProblem({ ...clean, tables: [...clean.tables, table] })).toMatch(/colour/i);
  });

  it('refuses a font missing any basic Latin letter', () => {
    expect(fontProblem({ ...clean, hasGlyph: (cp) => cp !== 'Q'.codePointAt(0) })).toMatch(/Latin/);
  });
});
