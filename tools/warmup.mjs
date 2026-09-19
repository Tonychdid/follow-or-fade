// Waits until the app is actually ready to be filmed, then says so.
// Cold start builds the training deck and the Live Floor in the background; recording before that
// finishes gives you an empty floor and a spinner on camera.
const BASE = `http://localhost:${process.env.PORT || 3000}`;
const WANT_CARDS = Number(process.env.WARM_CARDS || 6);
const DEADLINE = Date.now() + 12 * 60e3;

const get = (p) => fetch(BASE + p).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (s) => process.stdout.write(`\r\x1b[K${s}`);

console.log('\n  Warming up Follow or Fade for recording...\n');

// Separate, much shorter deadline for the first connection: if the server is not coming up at all,
// say so in a minute rather than sitting on "waiting..." for twelve.
const BOOT_DEADLINE = Date.now() + 90e3;
let up = false;
while (Date.now() < BOOT_DEADLINE && !up) {
  if (await get('/api/status')) { up = true; break; }
  line(`  waiting for the server to start... (${Math.round((BOOT_DEADLINE - Date.now()) / 1000)}s)`);
  await wait(1000);
}
if (!up) {
  console.log('\n\n  Could not reach the app on ' + BASE + '.');
  console.log('  Check the other window ("Follow or Fade server") for a red error message.');
  console.log('  Most common cause: something else is already using port 3000.\n');
  process.exit(1);
}
console.log('  Server is up.                    ');

const st = await get('/api/status');
if (st?.usage?.demo) {
  console.log('\n  *** WARNING: running in DEMO mode - the whales on screen are fake. ***');
  console.log('  Put your real key in the .env file (NANSEN_API_KEY=...) and restart before recording.\n');
}

// /api/live returns a bare array; older builds wrapped it in { items }. Accept both.
const countCards = (v) => (Array.isArray(v) ? v.length : Array.isArray(v?.items) ? v.items.length : 0);
let cards = 0, calibrated = false;
while (Date.now() < DEADLINE) {
  cards = countCards(await get('/api/live'));
  const s = await get('/api/status');
  calibrated = (s?.model?.n ?? 0) > 0 || (s?.sampleSize ?? 0) > 0;
  // Only the whale cards are worth waiting for. Calibration is reported, never blocking: it needs
  // resolved trades to accumulate and may legitimately still be zero on a fresh install.
  if (cards >= WANT_CARDS) break;
  line(`  Live Floor: ${cards}/${WANT_CARDS} whale cards   |   odds model: ${calibrated ? 'calibrated' : 'not yet'}   (${Math.round((DEADLINE - Date.now()) / 1000)}s left)`);
  await wait(5000);
}
console.log(`\n  Live Floor: ${cards} whale cards.   Odds model: ${calibrated ? 'calibrated' : 'not calibrated yet (fine - the floor still works)'}`);
if (cards < WANT_CARDS) console.log(`  Fewer than ${WANT_CARDS} cards - the floor only shows whales still holding, so a quiet hour looks thinner. Still filmable.`);
console.log('');

console.log('  ===========================================================');
console.log('   READY. Before you hit record:');
console.log('   1. Open a NEW private window  (Ctrl+Shift+N)  ->  localhost:3000');
console.log('   2. Do NOT type the nickname yet - the front door is your opening shot');
console.log('   3. Live Floor: place 3 Ride the Whale bets ($500-$1000) on different whales,');
console.log('      then leave it running ~20 min so some are winning and some losing');
console.log('   4. In a SECOND private window, play 10-12 training hands so the');
console.log('      Trader Profile has real scores to show');
console.log('   5. F11 for full screen, browser zoom 100%, sound on at ~50%');
console.log('   6. Win+G -> Settings -> Capturing: microphone OFF, "Audio to record" = Game');
console.log('  ===========================================================\n');
