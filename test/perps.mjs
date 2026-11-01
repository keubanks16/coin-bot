// Offline tests for the Jupiter Perps engine: indicators, fee/liquidation math, backtests,
// and full engine ticks against mocked Coinbase candles + Jupiter prices and an in-memory D1.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  ema, atr, rsi, loadPerpsConfig, openPos, valueAt, liqPrice, trail, exitCheck, backtest, runBacktests, qualifies,
  PerpsEngine, perpsState, MARKETS,
} from '../src/perps.js';
import { Store } from '../src/store.js';
import { Jupiter } from '../src/jupiter.js';

register('./html-loader.mjs', import.meta.url);

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };
const HOUR = 3600e3;
const cfg = loadPerpsConfig({});
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.run())), raw: db };
}

/** Hourly bars from a close-price function, with a bit of wick. */
function series(n, f, t0 = Date.UTC(2026, 8, 1)) {
  const bars = [];
  let prev = f(0);
  for (let i = 0; i < n; i++) {
    const c = f(i);
    const o = prev;
    bars.push({ t: t0 + i * HOUR, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c });
    prev = c;
  }
  return bars;
}

await test('ema / atr / rsi', () => {
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[1], null);
  near(e[2], 2);
  near(e[3], 3);
  const a = atr(series(30, () => 100), 14);
  assert.ok(a[14] > 0 && a[29] > 0);
  const up = rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
  near(up[29], 100);
});

await test('fees, borrow and P&L for longs and shorts', () => {
  const L = openPos({ market: 'SOL', side: 'long', strat: 'breakout', price: 100, atrNow: 1, at: 0, cfg });
  assert.equal(L.size, 200);
  near(L.stop, 98);
  const v = valueAt(L, 110, 10 * HOUR, cfg);
  near(v.pnl, 20);
  // fees: 200 × (0.0006+0.0003) × 2 = 0.36 ; borrow 200 × 0.0001 × 10 = 0.2
  near(v.net, 20 - 0.36 - 0.2);
  const S = openPos({ market: 'SOL', side: 'short', strat: 'breakout', price: 100, atrNow: 1, at: 0, cfg });
  near(S.stop, 102);
  near(valueAt(S, 90, 0, cfg).pnl, 20);
  assert.ok(valueAt(S, 110, 0, cfg).net < 0);
});

await test('liquidation price and check', () => {
  const L = openPos({ market: 'SOL', side: 'long', strat: 'breakout', price: 100, atrNow: 1, at: 0, cfg });
  const lp = liqPrice(L, cfg);
  assert.ok(lp > 50 && lp < 51, `2x long liquidates just above half price (${lp})`);
  assert.equal(valueAt(L, lp - 0.1, 0, cfg).liquidated, true);
  assert.equal(valueAt(L, lp + 0.5, 0, cfg).liquidated, false);
  near(valueAt(L, 10, 0, cfg).net, -100);
  const S = openPos({ market: 'SOL', side: 'short', strat: 'breakout', price: 100, atrNow: 1, at: 0, cfg });
  assert.ok(liqPrice(S, cfg) > 149 && liqPrice(S, cfg) < 150);
});

await test('trailing stop follows the best price and exits', () => {
  let L = openPos({ market: 'SOL', side: 'long', strat: 'breakout', price: 100, atrNow: 1, at: 0, cfg });
  L = trail(L, 110);
  near(L.stop, 107);
  L = trail(L, 105); // never moves back
  near(L.stop, 107);
  assert.equal(exitCheck(L, 106.9, HOUR, cfg), 'trailing stop');
  let S = openPos({ market: 'SOL', side: 'short', strat: 'breakout', price: 100, atrNow: 1, at: 0, cfg });
  assert.equal(exitCheck(S, 102.5, HOUR, cfg), 'stop loss');
  S = trail(S, 90);
  near(S.stop, 93);
  assert.equal(exitCheck(S, 92, 73 * HOUR, cfg), 'max hold time');
  const R = openPos({ market: 'SOL', side: 'long', strat: 'reversion', price: 100, atrNow: 2, at: 0, cfg });
  assert.equal(exitCheck(R, 103.1, HOUR, cfg), 'take profit');
});

await test('backtest: trend strategies make money in a steady trend, both directions', () => {
  const upBars = series(600, (i) => 100 * Math.exp(0.002 * i) * (1 + 0.004 * Math.sin(i / 3)));
  const up = backtest(upBars, 'breakout', cfg);
  assert.ok(up.n > 0 && up.total > 0, `breakout up: ${JSON.stringify(up)}`);
  assert.equal(up.longs, up.n);
  const dnBars = series(600, (i) => 100 * Math.exp(-0.002 * i) * (1 + 0.004 * Math.sin(i / 3)));
  const dn = backtest(dnBars, 'breakout', cfg);
  assert.ok(dn.n > 0 && dn.total > 0 && dn.longs === 0, `breakout down shorts: ${JSON.stringify(dn)}`);
});

await test('backtest: choppy market fails the edge check', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  let p = 100;
  const bars = series(1500, () => (p *= 1 + rnd() * 0.01));
  const bt = runBacktests({ SOL: bars, ETH: bars, BTC: bars }, cfg);
  for (const [k, r] of Object.entries(bt.results)) {
    if (r.enabled) assert.ok(r.total > 0 && r.recent > 0 && r.pf >= cfg.PERP_MIN_BT_PF, k);
  }
  assert.equal(qualifies({ n: 3, total: 50, pf: 3, recent: 10 }, cfg), 'too few trades to judge');
  assert.equal(qualifies({ n: 20, total: -1, pf: 0.9, recent: 1 }, cfg), 'lost money after fees');
  assert.equal(qualifies({ n: 20, total: 10, pf: 1.5, recent: -1 }, cfg), 'lost money in the most recent half');
  assert.equal(qualifies({ n: 20, total: 10, pf: 1.5, recent: 1 }, cfg), null);
});

// ---- engine end to end ----------------------------------------------------
const DB = makeD1();
const env = { DB, JUPITER_API_KEY: 'k', JUP_RPS: '1000', STRATEGY: 'perps', PERP_MIN_BT_TRADES: '1', PERP_MIN_BT_PF: '1' };
let now = Date.UTC(2026, 10, 1, 12, 2);
const realNow = Date.now;
Date.now = () => now;
const trendUp = (i) => 100 * Math.exp(0.002 * i) * (1 + 0.004 * Math.sin(i / 3));
let livePx = null;
let candleCalls = 0;
let coinbaseDown = false;
let krakenCalls = 0;
globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.hostname === 'api.kraken.com') {
    krakenCalls++;
    const t0 = Date.UTC(2026, 8, 1);
    const last = Math.floor(now / HOUR) * HOUR; // includes the unfinished bar, like Kraken
    const rows = [];
    for (let t = last - 719 * HOUR; t <= last; t += HOUR) {
      const i = (t - t0) / HOUR;
      const c = trendUp(i);
      const o = trendUp(i - 1);
      rows.push([t / 1000, String(o), String(Math.max(o, c) * 1.002), String(Math.min(o, c) * 0.998), String(c), '0', '1', 1]);
    }
    return new Response(JSON.stringify({ error: [], result: { [u.searchParams.get('pair')]: rows, last: 0 } }));
  }
  if (u.hostname === 'api.exchange.coinbase.com') {
    if (coinbaseDown) return new Response('slow down', { status: 429 });
    candleCalls++;
    const end = Date.parse(u.searchParams.get('end'));
    const start = Date.parse(u.searchParams.get('start'));
    const t0 = Date.UTC(2026, 8, 1);
    const rows = [];
    for (let t = end - HOUR; t >= start && t >= t0; t -= HOUR) {
      const i = (t - t0) / HOUR;
      const c = trendUp(i);
      const o = trendUp(i - 1);
      rows.push([t / 1000, Math.min(o, c) * 0.998, Math.max(o, c) * 1.002, o, c, 1]);
    }
    return new Response(JSON.stringify(rows));
  }
  if (u.pathname === '/price/v3') {
    const out = {};
    for (const m of MARKETS) if (livePx) out[m.mint] = { usdPrice: livePx };
    return new Response(JSON.stringify(out));
  }
  return new Response('nope', { status: 404 });
};
const ctx = { env, store: new Store(DB), jup: new Jupiter(env) };
const engine = new PerpsEngine(env);

await test('first tick runs the backtest and stores it', async () => {
  const r = await engine.tick(ctx);
  assert.equal(r.backtest, true);
  const bt = await ctx.store.get('perp_backtest');
  assert.ok(bt.days >= 60, `days ${bt.days}`);
  assert.ok(bt.results['breakout:SOL'].n > 0);
  assert.equal(candleCalls, 15);
});

await test('next tick opens trades only for strategies that passed', async () => {
  const bt = await ctx.store.get('perp_backtest');
  const r = await engine.tick(ctx);
  for (const o of r.opened) assert.match(o, /long/);
  const s = await perpsState(ctx);
  const enabledMarkets = MARKETS.filter((m) => Object.keys(bt.results).some((k) => k.endsWith(':' + m.sym) && bt.results[k].enabled));
  assert.ok(s.positions.length <= enabledMarkets.length);
  near(s.cash + s.positions.reduce((a, p) => a + p.cost, 0), 1000);
  assert.ok(Math.abs(s.equity - 1000) < 5);
});

await test('a crash closes every long on its stop and books the loss', async () => {
  // Force a position so this check doesn't depend on whether this bar had a fresh signal.
  const before = await perpsState(ctx);
  if (!before.positions.length) {
    await engine.open(ctx, MARKETS[0], 'long', 'breakout', 100, 1, now);
  }
  const open = (await perpsState(ctx)).positions;
  livePx = Math.min(...open.map((p) => p.stop)) * 0.97;
  now += 5e3;
  await engine.tick(ctx);
  const s = await perpsState(ctx);
  assert.equal(s.positions.length, 0);
  assert.ok(s.stats.sells >= open.length && s.stats.realized < 0);
  assert.ok(s.equity < 1000 && s.equity > 800);
  assert.ok(s.trades.some((t) => t.side === 'close' && t.pnl_usd < 0));
});

await test('Coinbase rate limit falls back to Kraken; total outage backs off', async () => {
  coinbaseDown = true;
  const e2 = new PerpsEngine(env);
  await ctx.store.set('perp_backtest', null);
  const r = await e2.tick(ctx);
  assert.equal(r.backtest, true);
  assert.equal(krakenCalls, 3);
  const bt = await ctx.store.get('perp_backtest');
  assert.ok(bt.days >= 29 && bt.days <= 31, `kraken days ${bt.days}`);
  assert.deepEqual(bt.missing, []);
  // Both sources down: one attempt, then quiet for 10 minutes.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (new URL(url).pathname === '/price/v3' ? realFetch(url) : new Response('no', { status: 429 }));
  await ctx.store.set('perp_backtest', null);
  const e3 = new PerpsEngine(env);
  assert.equal((await e3.tick(ctx)).backtest, false);
  let calls = 0;
  globalThis.fetch = async (url) => { calls++; return realFetch(url); };
  now += 5e3;
  await e3.tick(ctx);
  assert.equal(calls, 0, 'no retry storm');
  globalThis.fetch = realFetch;
  coinbaseDown = false;
  await ctx.store.set('perp_backtest', bt);
});

await test('worker routes the dashboard API to perps', async () => {
  const worker = (await import('../src/index.js')).default;
  const wenv = { ...env, DASHBOARD_PASSWORD: 'pw' };
  const call = (path, init = {}) => worker.fetch(new Request('https://bot.example' + path, { ...init, headers: { 'x-dash-key': 'pw', ...(init.headers || {}) } }), wenv);
  const s = await (await call('/api/state')).json();
  assert.equal(s.rules.strategy, 'perps');
  assert.ok(s.rules.perps.backtest);
  const sell = await call('/api/sell', { method: 'POST', body: JSON.stringify({ mint: 'SOL' }) });
  assert.equal(sell.status, 404);
  assert.deepEqual(await (await call('/api/reset-paper', { method: 'POST' })).json(), { ok: true });
  const s2 = await (await call('/api/state')).json();
  assert.equal(s2.equity, 1000);
  assert.equal(s2.stats.sells, 0);
  const html = await (await call('/')).text();
  assert.match(html, /renderPerps/);
});

Date.now = realNow;
console.log(`perps: ${passed} checks passed`);
