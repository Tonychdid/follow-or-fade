// Share images, drawn on the server with no dependencies.
//
// A link posted on X or Telegram unfurls into whatever og:image the page names. One static
// screenshot for every page made every link look the same, and its text was unreadable at feed
// size. These cards are 1200x630 PNGs built from a 5x7 pixel font, scaled up: big enough to read in
// a timeline, and made from nothing but zlib, which ships with Node.
import zlib from 'node:zlib';

const W = 1200, H = 630;

// 5x7 glyphs. Lower case is drawn as upper case.
const G = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'], D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'], H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'], J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'], L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'], N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'], P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'], R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'], V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'], X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'], Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'], 3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], 9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'], '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'], ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'], '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '%': ['11000', '11001', '00010', '00100', '01000', '10011', '00011'], $: ['00100', '01111', '10100', '01110', '00101', '11110', '00100'],
  '/': ['00001', '00001', '00010', '00100', '01000', '10000', '10000'], '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'], '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'], "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'], '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'], '<': ['00010', '00100', '01000', '10000', '01000', '00100', '00010'],
  '>': ['01000', '00100', '00010', '00001', '00010', '00100', '01000'], '*': ['00000', '00100', '10101', '01110', '10101', '00100', '00000'],
  '·': ['00000', '00000', '00000', '01100', '01100', '00000', '00000'], _: ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
};

export const COLORS = {
  ink: [10, 7, 10], panel: [24, 19, 25], gold: [212, 175, 55], goldL: [245, 215, 122], ivory: [243, 234, 215],
  muted: [167, 157, 137], emerald: [34, 192, 126], ruby: [224, 68, 90], dim: [60, 50, 42],
};

function canvas() {
  const px = new Uint8Array(W * H * 3);
  const fill = (x, y, w, h, c) => {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0), x1 = Math.min(W, (x + w) | 0), y1 = Math.min(H, (y + h) | 0);
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) { const o = (j * W + i) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; }
  };
  const width = (s, scale) => String(s).length * 6 * scale - scale;
  /** Draws text; align 'left' | 'center' | 'right' around x. Returns the drawn width. */
  const text = (s, x, y, scale, c, align = 'left') => {
    s = String(s).toUpperCase();
    const w = width(s, scale);
    let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    for (const ch of s) {
      const g = G[ch] || G['?'];
      for (let r = 0; r < 7; r++) for (let k = 0; k < 5; k++) if (g[r][k] === '1') fill(cx + k * scale, y + r * scale, scale, scale, c);
      cx += 6 * scale;
    }
    return w;
  };
  /** Largest scale (up to max) at which s fits in maxW pixels. */
  const fit = (s, maxW, max) => { let sc = max; while (sc > 2 && width(s, sc) > maxW) sc--; return sc; };
  return { px, fill, text, width, fit };
}

// ---- PNG encoding
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encode(px) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * One share card. `lines` is the body: { text, scale, color, gap } drawn top to bottom and centred.
 * The frame, the wordmark and the footer are the same on every card, so every link reads as ours.
 */
export function card({ kicker = '', lines = [], footer = 'FOLLOW OR FADE · PLAY MONEY · NANSEN SMART MONEY DATA' }) {
  const c = canvas();
  c.fill(0, 0, W, H, COLORS.ink);
  c.fill(18, 18, W - 36, H - 36, COLORS.gold);
  c.fill(26, 26, W - 52, H - 52, COLORS.panel);
  c.fill(40, 40, W - 80, 2, COLORS.dim); c.fill(40, H - 42, W - 80, 2, COLORS.dim);
  // wordmark
  const fw = c.width('FOLLOW', 5), dw = c.width('FADE', 5), gap = 34;
  const start = W / 2 - (fw + gap + dw) / 2;
  c.text('FOLLOW', start, 62, 5, COLORS.goldL);
  c.fill(start + fw + gap / 2 - 6, 72, 12, 12, COLORS.ruby);
  c.text('FADE', start + fw + gap, 62, 5, COLORS.goldL);
  if (kicker) c.text(kicker, W / 2, 126, c.fit(kicker, W - 140, 3), COLORS.muted, 'center');
  // Centre the body between the kicker and the footer.
  const sized = lines.map((l) => ({ ...l, sc: c.fit(l.text, W - 120, l.scale || 6) }));
  const total = sized.reduce((a, l, i) => a + l.sc * 7 + (i < sized.length - 1 ? (l.gap ?? 26) : 0), 0);
  let y = Math.max(168, Math.round(168 + (H - 110 - 168 - total) / 2));
  for (const l of sized) {
    c.text(l.text, W / 2, y, l.sc, l.color || COLORS.ivory, 'center');
    y += l.sc * 7 + (l.gap ?? 26);
  }
  c.text(footer, W / 2, H - 78, c.fit(footer, W - 140, 3), COLORS.muted, 'center');
  return encode(c.px);
}
