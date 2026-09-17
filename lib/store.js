import fs from 'node:fs';
import path from 'node:path';
// Minimal JSON-file persistence. Good enough for a single-node game server.
// DATA_DIR lets a host mount a persistent volume (e.g. /data on Railway).
const DIR = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(DIR, { recursive: true });
const mem = new Map();
const dirty = new Set();
export function load(name, fallback) {
  if (mem.has(name)) return mem.get(name);
  const f = path.join(DIR, name + '.json');
  let v = fallback;
  try { if (fs.existsSync(f)) v = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { v = fallback; }
  mem.set(name, v);
  return v;
}
function write(name) {
  const f = path.join(DIR, name + '.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(mem.get(name)));
  fs.renameSync(f + '.tmp', f);
  dirty.delete(name);
}
const timers = new Map();
export function save(name, value) {
  mem.set(name, value);
  dirty.add(name);
  clearTimeout(timers.get(name));
  timers.set(name, setTimeout(() => write(name), 250));
}
export function flushAll() { for (const n of [...dirty]) { try { write(n); } catch {} } }
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushAll(); process.exit(0); });
