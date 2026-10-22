import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PREVIEW_HEIGHT, PREVIEW_PADDING, PREVIEW_WIDTH, previewLayout, renderFontPreview } from './font-preview';

const FONTS = join(__dirname, '../../../test/fixtures/fonts');
const lato = readFileSync(join(FONTS, 'Lato-Regular.ttf'));
const serif = readFileSync(join(FONTS, 'SourceSerif4-Regular.otf'));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('renderFontPreview', () => {
  it('draws a 480 × 160 PNG', () => {
    const png = renderFontPreview(lato, 'Lato Regular');
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    // IHDR: width and height, big-endian, at bytes 16 and 20.
    expect(png.readUInt32BE(16)).toBe(PREVIEW_WIDTH);
    expect(png.readUInt32BE(20)).toBe(PREVIEW_HEIGHT);
    expect([PREVIEW_WIDTH, PREVIEW_HEIGHT]).toEqual([480, 160]);
  });

  it('draws OTF (CFF) fonts too', () => {
    expect(renderFontPreview(serif, 'Source Serif 4').readUInt32BE(16)).toBe(480);
  });

  it('refuses empty text', () => {
    expect(() => renderFontPreview(lato, '   ')).toThrow();
  });
});

describe('previewLayout', () => {
  it('fits the name inside the padding', () => {
    const layout = previewLayout(lato, 'Lato Regular');
    expect(layout.inkLeft).toBeGreaterThanOrEqual(PREVIEW_PADDING - 0.5);
    expect(layout.inkWidth).toBeLessThanOrEqual(PREVIEW_WIDTH - 2 * PREVIEW_PADDING + 0.5);
  });

  it('shrinks a long name to fit rather than cropping it', () => {
    const short = previewLayout(lato, 'Lato');
    const long = previewLayout(lato, 'An Extremely Long Display Name For A Font Family Bold Italic');
    expect(long.scale).toBeLessThan(short.scale);
    expect(long.inkWidth).toBeLessThanOrEqual(PREVIEW_WIDTH - 2 * PREVIEW_PADDING + 0.5);
  });

  it('centres the name horizontally', () => {
    const layout = previewLayout(lato, 'Lato');
    const rightGap = PREVIEW_WIDTH - (layout.inkLeft + layout.inkWidth);
    expect(Math.abs(rightGap - layout.inkLeft)).toBeLessThan(1);
  });
});
