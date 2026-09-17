import fs from 'node:fs';
import path from 'node:path';
// Minimal JSON-file persistence. Good enough for a single-node game server.
// DATA_DIR lets a host mount a persistent volume (e.g. /data on Railway).
const DIR = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(DIR, { recursive: true });
const mem = new Map();
const dirty = new Set();
const corrupt = new Set(); // files we could not parse: never overwrite them blindly

export function load(name, fallback) {
  if (mem.has(name)) return mem.get(name);
  const f = path.join(DIR, name + '.json');
  let v = fallback;
  if (fs.existsSync(f)) {
    try { v = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) {
      // keep the damaged file aside instead of silently starting empty and overwriting real data
      const bak = `${f}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(f, bak); console.error(`[store] ${name}.json could not be read, saved a copy to ${path.basename(bak)}`); } catch {}
      corrupt.add(name);
      v = fallback;
    }
  }
  mem.set(name, v);
  return v;
}

function write(name) {
  try {
    const f = path.join(DIR, name + '.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(mem.get(name)));
    fs.renameSync(f + '.tmp', f);
    dirty.delete(name);
    corrupt.delete(name);
  } catch (e) {
    console.error(`[store] could not write ${name}.json: ${e.message}`); // e.g. disk full: keep running, retry on next save
  }
}

// Debounced writes, but never postponed forever under steady traffic: at most 250ms quiet, 2s max wait.
const timers = new Map();
const firstDirty = new Map();
export function save(name, value) {
  mem.set(name, value);
  dirty.add(name);
  if (!firstDirty.has(name)) firstDirty.set(name, Date.now());
  clearTimeout(timers.get(name));
  const wait = Math.max(0, Math.min(250, 2000 - (Date.now() - firstDirty.get(name))));
  timers.set(name, setTimeout(() => { firstDirty.delete(name); write(name); }, wait));
}
export function flushAll() { for (const n of [...dirty]) write(n); }
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushAll(); process.exit(0); });
