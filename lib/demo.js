// Demo data: same response shapes as Nansen, built on REAL Hyperliquid prices.
// Used only when no NANSEN_API_KEY is set (or DEMO=1). The UI shows a "DEMO DATA" badge.
import { candles } from './hyperliquid.js';

const COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'SUI', 'AVAX', 'LINK', 'ENA'];
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
const WALLETS = Array.from({ length: 25 }, (_, i) => ({
  address: '0x' + hex(40), label: `Demo Smart Trader #${i + 1}`, winRate: 0.38 + rnd() * 0.3,
}));
let tradesCache = null;
export const isDemoAddress = (a) => WALLETS.some((w) => w.address === a);

async function buildTrades() {
  if (tradesCache) return tradesCache;
  const now = Date.now(), start = now - 7 * 864e5;
  const out = [];
  for (const coin of COINS) {
    const rows = await candles(coin, start, now, '1h').catch(() => []);
    if (!rows.length) continue;
    for (let i = 0; i < 18; i++) {
      const r = rows[Math.floor(rnd() * rows.length)];
      const w = WALLETS[Math.floor(rnd() * WALLETS.length)];
      const t = r.t + Math.floor(rnd() * 3600e3);
      const side = rnd() > 0.5 ? 'Long' : 'Short';
      const value = Math.round(25000 + rnd() ** 3 * 2_000_000);
      out.push({
        trader_address_label: w.label, trader_address: w.address, token_symbol: coin, side,
        action: side === 'Long' ? 'Buy - Open Long' : 'Sell - Open Short',
        token_amount: value / r.c, price_usd: r.c, value_usd: value, type: rnd() > 0.3 ? 'Market' : 'Limit',
        block_timestamp: new Date(Math.min(t, now - 60e3)).toISOString(), transaction_hash: '0x' + hex(64), _demo: true,
      });
    }
  }
  out.sort((a, b) => b.block_timestamp.localeCompare(a.block_timestamp));
  return (tradesCache = out);
}

export async function post(endpoint, body) {
  await new Promise((r) => setTimeout(r, 60));
  if (endpoint === 'smart-money/perp-trades') {
    const all = await buildTrades();
    const since = Date.now() - (body.lookback_hours || 168) * 3600e3;
    let data = all.filter((t) => Date.parse(t.block_timestamp) >= since);
    if (body.lookback_hours <= 2 && data.length < 5) {
      // keep live mode lively in demo: re-stamp a few trades as fresh at current prices
      data = all.slice(0, 8).map((t, i) => ({ ...t, block_timestamp: new Date(Date.now() - (i + 1) * 6 * 60e3).toISOString() }));
    }
    return { data, pagination: { page: 1, per_page: data.length, is_last_page: true } };
  }
  if (endpoint === 'profiler/perp-pnl-summary') {
    const w = WALLETS.find((x) => x.address === body.address) || { winRate: 0.5 };
    const closed = 40 + Math.floor(rnd() * 400);
    return { data: {
      traded_coin_count: 3 + Math.floor(rnd() * 20), traded_times: closed * 2, closed_trade_count: closed,
      winning_trade_count: Math.round(closed * w.winRate), win_rate: w.winRate,
      realized_pnl_usd: Math.round((w.winRate - 0.45) * 4e6 + (rnd() - 0.5) * 5e5),
      realized_pnl_percent: (w.winRate - 0.45) * 0.4, fees_usd: Math.round(rnd() * 90000), top5_coins: [],
    } };
  }
  if (endpoint === 'perp-screener') {
    const coin = body.filters?.token_symbol || 'BTC';
    const vol = 5e6 + rnd() * 3e8;
    const pressure = (rnd() - 0.5) * vol * 0.2;
    return { data: [{ token_symbol: coin, volume: vol, buy_volume: (vol + pressure) / 2, sell_volume: (vol - pressure) / 2,
      buy_sell_pressure: pressure, trader_count: Math.floor(20 + rnd() * 900), funding: (rnd() - 0.45) * 0.0003,
      open_interest: vol * 3, mark_price: 0, previous_price_usd: 0 }], pagination: { is_last_page: true } };
  }
  if (endpoint === 'tgm/perp-positions') {
    const data = WALLETS.slice(0, 12).map((w) => ({ address: w.address, address_label: w.label, side: rnd() > 0.5 ? 'Long' : 'Short',
      position_value_usd: Math.round(5e4 + rnd() * 3e6), leverage: `${Math.ceil(rnd() * 20)}X` }));
    return { data, pagination: { is_last_page: true } };
  }
  return { data: [] };
}
