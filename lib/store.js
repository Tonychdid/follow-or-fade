import fs from 'node:fs';
import path from 'node:path';
// Minimal JSON-file persistence. Good enough for a single-node game server.
// DATA_DIR lets a host mount a persistent volume (e.g. /data on Railway).
const DIR = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(DIR, { recursive: true });
const mem = new Map();
const dirty = new Set();
const locked = new Set(); // files we could not parse AND could not back up: never overwrite them

export function load(name, fallback) {
  if (mem.has(name)) return mem.get(name);
  const f = path.join(DIR, name + '.json');
  let v = fallback;
  if (fs.existsSync(f)) {
    try { v = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) {
      // keep the damaged file aside instead of silently starting empty and overwriting real data
      const bak = `${f}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(f, bak); console.error(`[store] ${name}.json could not be read, saved a copy to ${path.basename(bak)}`); }
      catch (e2) {
        // No backup means the damaged file is the only copy there is: refuse to write over it.
        locked.add(name);
        console.error(`[store] ${name}.json is unreadable and could not be backed up (${e2.message}) — it will NOT be overwritten this run`);
      }
      v = fallback;
    }
  }
  mem.set(name, v);
  return v;
}

export const isLocked = (name) => locked.has(name);
function write(name) {
  if (locked.has(name)) { dirty.delete(name); console.error(`[store] DROPPED a write to ${name}.json: the file is unreadable and could not be backed up`); return; }
  try {
    const f = path.join(DIR, name + '.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(mem.get(name)));
    fs.renameSync(f + '.tmp', f);
    dirty.delete(name);
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
/**
 * Append-only JSONL, for records that must survive rotation.
 *
 * The .json helpers above hold a whole array in memory and rewrite it on every save, so every caller
 * caps its array to stay cheap — alerts.json keeps 200 and drops the rest. That is fine for "what is
 * on screen" and useless for "how did the whales we alerted on actually do", which needs months of
 * history nobody trimmed. This writes one line per record, never rewrites what is already on disk,
 * and costs the same whether the file holds ten records or a million.
 *
 * Failures are swallowed on purpose: a journal that cannot be written must never take an alert down
 * with it. The alert is the product; the journal is the audit trail.
 */
export function appendJsonl(name, obj) {
  try {
    fs.appendFileSync(path.join(DIR, name + '.jsonl'), JSON.stringify(obj) + '\n');
    return true;
  } catch (e) {
    console.error(`[store] could not append to ${name}.jsonl: ${e.message}`);
    return false;
  }
}

/** Read a JSONL file back. `limit` returns only the newest N. Unparseable lines are skipped, not fatal. */
export function readJsonl(name, limit = 0) {
  const f = path.join(DIR, name + '.jsonl');
  if (!fs.existsSync(f)) return [];
  let lines;
  try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch (e) { console.error(`[store] could not read ${name}.jsonl: ${e.message}`); return []; }
  lines = lines.filter((l) => l.trim());
  if (limit > 0 && lines.length > limit) lines = lines.slice(-limit);
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* a torn last line must not lose the file */ } }
  return out;
}

export const jsonlPath = (name) => path.join(DIR, name + '.jsonl');
export const jsonlStats = (name) => {
  try { const st = fs.statSync(path.join(DIR, name + '.jsonl')); return { bytes: st.size, modified: st.mtime.toISOString() }; }
  catch { return { bytes: 0, modified: null }; }
};

export function flushAll() { for (const n of [...dirty]) write(n); }
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushAll(); process.exit(0); });
