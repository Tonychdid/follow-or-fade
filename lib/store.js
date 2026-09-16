import fs from 'node:fs';
import path from 'node:path';
// Minimal JSON-file persistence. Good enough for a single-node game server.
const DIR = path.resolve('data');
fs.mkdirSync(DIR, { recursive: true });
const mem = new Map();
export function load(name, fallback) {
  if (mem.has(name)) return mem.get(name);
  const f = path.join(DIR, name + '.json');
  let v = fallback;
  try { if (fs.existsSync(f)) v = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { v = fallback; }
  mem.set(name, v);
  return v;
}
const timers = new Map();
export function save(name, value) {
  mem.set(name, value);
  clearTimeout(timers.get(name));
  timers.set(name, setTimeout(() => {
    const f = path.join(DIR, name + '.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(value));
    fs.renameSync(f + '.tmp', f);
  }, 250));
}
