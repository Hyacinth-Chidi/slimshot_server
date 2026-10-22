import { Resvg } from '@resvg/resvg-js';
import * as fontkit from 'fontkit';

export const PREVIEW_WIDTH = 480;
export const PREVIEW_HEIGHT = 160;
export const PREVIEW_PADDING = 24;

interface Run {
  glyphs: Array<{ path: { toSVG(): string } }>;
  positions: Array<{ xAdvance: number; xOffset: number; yOffset: number }>;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

function layOut(font: Buffer, text: string): Run {
  const name = text.trim();
  if (!name) throw new Error('A preview needs some text to draw.');
  const face = fontkit.create(font) as unknown as { layout(text: string): Run };
  const run = face.layout(name);
  const { minX, maxX, minY, maxY } = run.bbox;
  if (![minX, maxX, minY, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) {
    throw new Error('The font draws nothing for this text.');
  }
  return run;
}

/** Where the drawn text lands: scaled to fit inside the padding, centred both ways. */
function fit(run: Run) {
  const { minX, maxX, minY, maxY } = run.bbox;
  const scale = Math.min(
    (PREVIEW_WIDTH - 2 * PREVIEW_PADDING) / (maxX - minX),
    (PREVIEW_HEIGHT - 2 * PREVIEW_PADDING) / (maxY - minY),
  );
  const inkWidth = (maxX - minX) * scale;
  const inkLeft = (PREVIEW_WIDTH - inkWidth) / 2;
  // Font units point up; the image's y points down, hence the flip below.
  return { scale, inkWidth, inkLeft, originX: inkLeft - minX * scale, baseline: PREVIEW_HEIGHT / 2 + ((maxY + minY) * scale) / 2 };
}

/** The fit maths on its own, so it can be checked without decoding pixels. */
export function previewLayout(font: Buffer, text: string): { scale: number; inkWidth: number; inkLeft: number } {
  const { scale, inkWidth, inkLeft } = fit(layOut(font, text));
  return { scale, inkWidth, inkLeft };
}

/**
 * The tile the app shows for a font: its name drawn in the font itself, white
 * on transparent, 480 × 160. Drawn from the exact file the app downloads, so
 * the preview always matches it.
 */
export function renderFontPreview(font: Buffer, text: string): Buffer {
  const run = layOut(font, text);
  const { scale, originX, baseline } = fit(run);

  let penX = 0;
  const paths = run.glyphs.map((glyph, i) => {
    const pos = run.positions[i];
    const d = glyph.path.toSVG();
    const placed = d ? `<path transform="translate(${penX + pos.xOffset} ${pos.yOffset})" d="${d}"/>` : '';
    penX += pos.xAdvance;
    return placed;
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}">` +
    `<g fill="#ffffff" transform="translate(${originX} ${baseline}) scale(${scale} ${-scale})">${paths.join('')}</g>` +
    `</svg>`;
  return Buffer.from(new Resvg(svg).render().asPng());
}
