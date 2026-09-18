import crypto from 'node:crypto';
import * as store from './store.js';

// Waitlist for paid plans. No payment is ever taken here — we only record that someone asked to be
// told when Premium opens.
//
// GDPR notes, because this is the only place the site touches an email address:
//  - Consent is the lawful basis (Art. 6(1)(a)), so it has to be a real opt-in: an unticked box, a
//    specific purpose, and no bundling with anything else. The server refuses a signup without it.
//  - Art. 7(1) means we must be able to DEMONSTRATE consent, so we store what the person agreed to,
//    the exact wording they were shown, and when.
//  - Art. 7(3) says withdrawing must be as easy as giving, so every record carries a one-click
//    unsubscribe token and there is a self-serve deletion route. No email or login needed to use it.
//  - Data minimisation (Art. 5(1)(c)): we keep the email, the plan, the consent proof and nothing else.
//    No IP address is stored — the consent record does not need one to be valid.
const PLANS = ['free', 'basic', 'premium'];

// Bump this whenever the consent wording changes: old records keep the text they actually agreed to.
export const CONSENT_VERSION = '2026-09-18';
export const CONSENT_TEXT =
  'I agree to Follow or Fade storing my email address so it can tell me when paid plans open. '
  + 'I understand this is the only thing it will be used for, that it will not be shared with anyone, '
  + 'and that I can withdraw my consent and have it deleted at any time.';

const list = store.load('waitlist', []);

export function beta() {
  return { status: 'free-beta' }; // free during the beta, paid plans coming soon (no end date is promised)
}

export function consentNotice() {
  return { version: CONSENT_VERSION, text: CONSENT_TEXT };
}

/** Public config for the signup form, so the wording on screen and the wording we store can't drift. */
export function join({ email, plan, consent, consentVersion }) {
  const e = String(email || '').trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw Object.assign(new Error('That email looks off. Try again?'), { status: 400 });
  // Explicit, unambiguous, affirmative: a missing or false box is a refusal, not a default.
  if (consent !== true) throw Object.assign(new Error('Please tick the consent box so we may store your email.'), { status: 400 });
  if (String(consentVersion || '') !== CONSENT_VERSION) {
    throw Object.assign(new Error('This form is out of date. Reload the page and try again.'), { status: 409 });
  }
  if (store.isLocked('waitlist')) throw Object.assign(new Error('We cannot save your email right now. Try again in a little while.'), { status: 503 });
  const p = PLANS.includes(plan) ? plan : 'premium';
  const token = crypto.randomBytes(16).toString('hex'); // the unsubscribe key; never guessable
  const existing = list.find((x) => x.email === e);
  if (existing) {
    // Someone who is already on the list gets a FRESH token, and their stored consent proof is left
    // exactly as it was. Otherwise anyone who guessed an address could fetch that person's removal
    // key, and could rewrite the record to claim they agreed to wording they never saw.
    existing.token = token;
    existing.plan = p; existing.updated = Date.now();
    store.save('waitlist', list);
  } else {
    if (list.length >= 50000) throw Object.assign(new Error('Waitlist is full for now.'), { status: 503 });
    list.push({ email: e, plan: p, at: Date.now(), token,
      consent: { at: Date.now(), version: CONSENT_VERSION, text: CONSENT_TEXT } });
    store.save('waitlist', list);
  }
  // Identical response either way: whether an address is already on the list is not public information.
  return { ok: true, token, ...beta() };
}

/**
 * Withdraw consent and delete the record. Art. 7(3): as easy as giving consent — one click, no
 * account, no reply-and-wait. Returns ok either way so the endpoint can't be used to test whether
 * a given address is on the list.
 */
export function leave({ token }) {
  // Token only. Accepting a bare email would let anyone delete anyone else's record, and would answer
  // "is this address on the list?" for free. Someone who has lost their link writes to the operator.
  const t = String(token || '').trim();
  const i = t ? list.findIndex((x) => x.token === t) : -1;
  if (i >= 0) { list.splice(i, 1); store.save('waitlist', list); return { ok: true, removed: true }; }
  return { ok: true, removed: false };
}

/** Everything held about one address, for an Art. 15 access request. */
export function lookup(token) {
  const x = list.find((r) => r.token === String(token || '').trim());
  if (!x) return null;
  return { email: x.email, plan: x.plan, joined: new Date(x.at).toISOString(),
    consent: { givenAt: new Date(x.consent?.at ?? x.at).toISOString(), version: x.consent?.version ?? 'unrecorded', text: x.consent?.text ?? 'unrecorded' } };
}

export const size = () => list.length;

export function csv() {
  // quote cells and neutralise spreadsheet formulas (=, +, -, @ at the start)
  const q = (s) => { let v = String(s ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return `"${v.replace(/"/g, '""')}"`; };
  return 'email,plan,joined_utc,consent_utc,consent_version\n'
    + list.map((x) => [q(x.email), q(x.plan), q(new Date(x.at).toISOString()),
      q(x.consent?.at ? new Date(x.consent.at).toISOString() : ''), q(x.consent?.version ?? '')].join(',')).join('\n') + '\n';
}
