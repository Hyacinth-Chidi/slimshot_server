import { Resvg } from '@resvg/resvg-js';
import * as fontkit from 'fontkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FONTS = join(__dirname, '../../../test/fixtures/fonts');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The two libraries the font kind relies on load and work under Jest. */
describe('font libraries', () => {
  it('fontkit reads a TTF and an OTF', () => {
    const lato = fontkit.create(readFileSync(join(FONTS, 'Lato-Regular.ttf'))) as fontkit.Font;
    expect(lato.familyName).toBe('Lato');
    const serif = fontkit.create(readFileSync(join(FONTS, 'SourceSerif4-Regular.otf'))) as fontkit.Font;
    expect(serif.familyName).toContain('Source Serif');
  });

  it('resvg turns an SVG into a PNG', () => {
    const png = new Resvg('<svg width="480" height="160" xmlns="http://www.w3.org/2000/svg"/>').render().asPng();
    expect(Buffer.from(png).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });
});
