// A Telegram dashboard as a picture (owner, Sep 24; used by the Elite bot and the Follow or Fade bot): Telegram draws the <pre> grid in a small fixed
// font that a bot cannot enlarge, so the grid is drawn as a PNG with big numbers that fill the width,
// and the rest of the message rides along as the photo's caption.
//
// Drawn from an SVG with resvg (a prebuilt renderer, no system libraries) and the Inter font shipped
// in an npm package, so it looks the same on Railway as anywhere else. If either is missing, the
// renderer reports itself unavailable and the bot sends the text message exactly as before.
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let engine;                                   // undefined = not tried, null = unavailable
function load() {
  if (engine !== undefined) return engine;
  try {
    const { Resvg } = require('@resvg/resvg-js');
    const dir = path.dirname(require.resolve('@expo-google-fonts/inter/package.json'));
    const fontFiles = ['400Regular/Inter_400Regular.ttf', '600SemiBold/Inter_600SemiBold.ttf', '700Bold/Inter_700Bold.ttf'].map((f) => path.join(dir, f));
    engine = { Resvg, fontFiles };
  } catch { engine = null; }
  return engine;
}
export const available = () => !!load();
export const _disable = (off = true) => { engine = off ? null : undefined; };      // tests

const W = 1080, PAD = 64, COL_B = W - PAD, COL_A = W - PAD - 340;
const INK = '#111827', INK2 = '#4B5563', MUTED = '#6B7280', LINE = '#E5E7EB', UP = '#15803D', DOWN = '#B91C1C', BG = '#FFFFFF', BAND = '#F3F4F6';
const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Signed money and percentages carry their direction in color as well as in the sign.
const tone = (v) => (/^[+]\$?[\d.]/.test(v) && !/^\+\$?0(\.0+)?%?$/.test(v) ? UP : /^[-−]\$?[\d.]/.test(v) ? DOWN : INK);

/**
 * sections: [{ header?: [label, colA, colB], rows: [[label, a, b?]] }]. A row with two cells puts its
 * value in the right column; three cells fill both columns.
 */
export function svgOf({ title, subtitle, badge, sections }) {
  const out = [];
  let y = PAD;
  // Title band
  out.push(`<text x="${PAD}" y="${y + 50}" font-family="Inter" font-weight="700" font-size="54" fill="${INK}">${x(title)}</text>`);
  if (badge) {
    const bw = 24 + badge.length * 19;
    out.push(`<rect x="${W - PAD - bw}" y="${y + 8}" width="${bw}" height="52" rx="26" fill="${BAND}"/>`,
      `<text x="${W - PAD - bw / 2}" y="${y + 44}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="28" fill="${INK2}">${x(badge)}</text>`);
  }
  y += 70;
  if (subtitle) { out.push(`<text x="${PAD}" y="${y + 36}" font-family="Inter" font-size="34" fill="${MUTED}">${x(subtitle)}</text>`); y += 50; }
  y += 24;
  for (const s of sections) {
    if (!s.rows.length) continue;
    out.push(`<line x1="${PAD}" x2="${W - PAD}" y1="${y}" y2="${y}" stroke="${LINE}" stroke-width="3"/>`);
    y += 16;
    if (s.header) {
      const [l, a, b] = s.header;
      out.push(`<text x="${PAD}" y="${y + 44}" font-family="Inter" font-weight="700" font-size="32" letter-spacing="2" fill="${MUTED}">${x(l)}</text>`);
      if (a) out.push(`<text x="${COL_A}" y="${y + 44}" text-anchor="end" font-family="Inter" font-weight="700" font-size="32" letter-spacing="2" fill="${MUTED}">${x(a)}</text>`);
      if (b) out.push(`<text x="${COL_B}" y="${y + 44}" text-anchor="end" font-family="Inter" font-weight="700" font-size="32" letter-spacing="2" fill="${MUTED}">${x(b)}</text>`);
      y += 64;
    }
    for (const r of s.rows) {
      const [l, a, b] = r;
      out.push(`<text x="${PAD}" y="${y + 54}" font-family="Inter" font-size="44" fill="${INK2}">${x(l)}</text>`);
      if (r.length === 2) out.push(`<text x="${COL_B}" y="${y + 54}" text-anchor="end" font-family="Inter" font-weight="600" font-size="48" fill="${tone(a)}">${x(a)}</text>`);
      else {
        if (a) out.push(`<text x="${COL_A}" y="${y + 54}" text-anchor="end" font-family="Inter" font-weight="600" font-size="48" fill="${tone(a)}">${x(a)}</text>`);
        if (b) out.push(`<text x="${COL_B}" y="${y + 54}" text-anchor="end" font-family="Inter" font-weight="600" font-size="48" fill="${tone(b)}">${x(b)}</text>`);
      }
      y += 76;
    }
    y += 20;
  }
  const H = y + PAD - 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${BG}"/>${out.join('')}</svg>`;
}

/** PNG bytes for the model, or null when the renderer is not installed or fails. */
export function render(model) {
  const e = load();
  if (!e) return null;
  try {
    const r = new e.Resvg(svgOf(model), { font: { fontFiles: e.fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' }, fitTo: { mode: 'width', value: W } });
    return Buffer.from(r.render().asPng());
  } catch { return null; }
}

/**
 * Turn the text grids of a card back into sections. Each grid row carries its cells (see elitebot's
 * kv/row3); an empty row starts a new section; a first row in capitals (POSITION, RECORD) is a header.
 */
export function sectionsOf(grids) {
  const out = [];
  for (const rows of grids || []) {
    let cur = { rows: [] };
    out.push(cur);
    for (const r of rows) {
      const cells = r && r.cells;
      if (!cells) { if (cur.rows.length || cur.header) { cur = { rows: [] }; out.push(cur); } continue; }
      if (!cur.header && !cur.rows.length && cells.length >= 2 && /^[A-Z]{3,}$/.test(cells[0])) cur.header = cells.length === 2 ? [cells[0], '', cells[1]] : cells;
      else cur.rows.push(cells.map((c) => String(c ?? '')));
    }
  }
  return out.filter((s) => s.rows.length);
}
