// Offline tests for the pump.fun sniper: curve math, decoding, and full engine runs against
// simulated coins (mocked Solana RPC, Jupiter SOL price and coin metadata).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decodeCurve, curveBuy, curveSell, curveMcapSol, PumpEngine } from '../src/pump.js';
import { makeContext, sellPosition } from '../src/bot.js';
import { loadConfig } from '../src/strategy.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ✓', name);
}

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

// ---- simulated pump.fun coins -----------------------------------------------------------
const START_VTOK = 1_073_000_000_000_000n;
const START_VSOL = 30_000_000_000n;
const REAL_TOK = 793_100_000_000_000n;
const SUPPLY = 1_000_000_000_000_000n;

function newCurve() {
  return { vTok: START_VTOK, vSol: START_VSOL, realTok: REAL_TOK, realSol: 0n, supply: SUPPLY, complete: false };
}
/** Someone buys `sol` SOL worth (no fees, just moves the curve). Negative = someone sells. */
function trade(c, sol) {
  const k = c.vSol * c.vTok;
  c.vSol += BigInt(Math.round(sol * 1e9));
  c.realSol += BigInt(Math.round(sol * 1e9));
  const newTok = k / c.vSol;
  c.realTok -= c.vTok - newTok;
  c.vTok = newTok;
}
function encode(c) {
  const b = new Uint8Array(151);
  b.set([23, 183, 248, 55, 96, 216, 172, 96]);
  const dv = new DataView(b.buffer);
  [c.vTok, c.vSol, c.realTok, c.realSol, c.supply].forEach((v, i) => dv.setBigUint64(8 + i * 8, v, true));
  b[48] = c.complete ? 1 : 0;
  return b;
}

function installMock(world) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const reply = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (u.pathname === '/price/v3') return reply({ So11111111111111111111111111111111111111112: { usdPrice: 150 } });
    if (u.hostname === 'meta.test') return reply(world.meta[u.pathname.slice(1)] || {});
    if (u.hostname === 'api.mainnet-beta.solana.com') {
      const body = JSON.parse(init.body);
      if (body.method === 'getMultipleAccounts') {
        return reply({ result: { value: body.params[0].map((k) => (world.curves[k] ? { data: [Buffer.from(encode(world.curves[k])).toString('base64'), 'base64'] } : null)) } });
      }
      if (body.method === 'getTokenAccountsByOwner') {
        const amount = String(world.devBalance[body.params[1].mint] ?? 0);
        return reply({ result: { value: amount === '0' ? [] : [{ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } }] } });
      }
    }
    return new Response('not mocked: ' + url, { status: 404 });
  };
}

function launch(world, engine, mint, t, { devPct = 3, socials = true } = {}) {
  const curve = newCurve();
  const devSol = devPct > 0 ? 0.5 : 0;
  if (devSol) trade(curve, devSol);
  world.curves['curve-' + mint] = curve;
  world.meta[mint] = socials ? { name: mint, twitter: 'https://x.com/' + mint } : { name: mint };
  world.devBalance[mint] = Math.round(devPct * 1e7 * 1e6);
  engine.handleMessage(
    { txType: 'create', mint, symbol: mint, name: mint, pool: 'pump', bondingCurveKey: 'curve-' + mint, traderPublicKey: 'dev-' + mint,
      initialBuy: devPct * 1e7, solAmount: devSol, vSolInBondingCurve: Number(curve.vSol) / 1e9, uri: 'https://meta.test/' + mint },
    t,
    loadConfig({ STRATEGY: 'pump' }),
  );
  return curve;
}

async function setup(extraEnv = {}) {
  const DB = makeD1();
  const world = { curves: {}, meta: {}, devBalance: {} };
  installMock(world);
  const env = { DB, STRATEGY: 'pump', JUP_RPS: '1000', ...extraEnv };
  const engine = new PumpEngine(env);
  engine.feedDisabled = true;
  const tick = async (t) => engine.tick(await makeContext(env), t);
  return { DB, world, env, engine, tick };
}
const trades = (DB) => DB.raw.prepare('SELECT side, symbol, usd, pnl_usd, reason FROM trades ORDER BY id').all();
const events = (DB) => DB.raw.prepare('SELECT msg FROM events ORDER BY id').all().map((e) => e.msg).join('\n');

// ---- tests ------------------------------------------------------------------------------
console.log('pump.fun math');
await test('decodes a bonding curve account', () => {
  const c = newCurve();
  trade(c, 5);
  const d = decodeCurve(encode(c));
  assert.equal(d.vSol, c.vSol);
  assert.equal(d.vTok, c.vTok);
  assert.equal(d.complete, false);
  assert.equal(d.quoteIsSol, true);
  assert.equal(decodeCurve(new Uint8Array(151)), null, 'wrong discriminator');
});

await test('launch market cap is about 28 SOL', () => {
  const m = curveMcapSol(newCurve());
  assert.ok(m > 27.9 && m < 28.0, String(m));
});

await test('buy then immediate sell loses about the fees', () => {
  const c = newCurve();
  const tokens = curveBuy(c, 1_000_000_000n, 125);
  trade(c, 1 / 1.0125);
  const back = Number(curveSell(c, tokens, 125)) / 1e9;
  assert.ok(back > 0.97 && back < 0.98, String(back));
});

console.log('pump.fun engine');
await test('buys a coin with real buying, rides it, sells on the first downturn for a profit', async () => {
  const { DB, world, engine, tick } = await setup();
  const t0 = Date.now();
  const c = launch(world, engine, 'MOON', t0);
  let t = t0;
  for (let i = 1; i <= 8; i++) { // ~0.5 SOL of buying every 2s
    t = t0 + i * 2000;
    trade(c, 0.5);
    await tick(t);
  }
  let tr = trades(DB);
  assert.equal(tr.length, 1, 'bought once');
  assert.equal(tr[0].side, 'buy');
  assert.equal(tr[0].usd, 20);
  assert.match(events(DB), /BUY MOON \$20\.00/);
  for (let i = 0; i < 10; i++) { // big run-up
    t += 2000;
    trade(c, 3);
    await tick(t);
  }
  assert.equal(trades(DB).length, 1, 'still holding while it climbs');
  t += 2000;
  trade(c, -12); // first real drop
  await tick(t);
  tr = trades(DB);
  assert.equal(tr.length, 2);
  assert.equal(tr[1].reason, 'first downturn');
  assert.ok(tr[1].pnl_usd > 5, `profit ${tr[1].pnl_usd}`);
  const cash = JSON.parse(DB.raw.prepare("SELECT v FROM state WHERE k='paper_cash'").get().v);
  assert.ok(Math.abs(cash - (1000 + tr[1].pnl_usd)) < 1e-6);
});

await test('cuts a loser at the stop loss', async () => {
  const { DB, world, engine, tick } = await setup();
  const t0 = Date.now();
  const c = launch(world, engine, 'DUMP', t0);
  let t = t0;
  for (let i = 1; i <= 8; i++) { t = t0 + i * 2000; trade(c, 0.5); await tick(t); }
  assert.equal(trades(DB).length, 1);
  t += 2000;
  trade(c, -6); // rugged
  await tick(t);
  const tr = trades(DB);
  assert.equal(tr[1].reason, 'stop loss');
  assert.ok(tr[1].pnl_usd < -5);
});

await test('sells a coin when the buying stops', async () => {
  const { DB, world, engine, tick } = await setup();
  const t0 = Date.now();
  const c = launch(world, engine, 'FLAT', t0);
  let t = t0;
  for (let i = 1; i <= 8; i++) { t = t0 + i * 2000; trade(c, 0.5); await tick(t); }
  for (let i = 0; i < 25; i++) { t += 2000; await tick(t); } // 50s, nobody buys
  const tr = trades(DB);
  assert.equal(tr.length, 2);
  assert.equal(tr[1].reason, 'stalled');
});

await test('skips coins with no social links, a big creator bag, or a creator who sold', async () => {
  const { DB, world, engine, tick } = await setup();
  const t0 = Date.now();
  const a = launch(world, engine, 'NOSOC', t0, { socials: false });
  const b = launch(world, engine, 'WHALE', t0, { devPct: 25 });
  const d = launch(world, engine, 'RUGDEV', t0);
  world.devBalance.RUGDEV = 0;
  for (let i = 1; i <= 8; i++) {
    for (const c of [a, b, d]) trade(c, 0.5);
    await tick(t0 + i * 2000);
  }
  assert.equal(trades(DB).length, 0);
  const ev = events(DB);
  assert.match(ev, /Skip NOSOC: no social links/);
  assert.match(ev, /Skip RUGDEV: creator sold/);
  assert.ok(!engine.watch.has('WHALE'), 'big creator bag never watched');
});

await test('ignores a coin that already pumped past the market-cap limit', async () => {
  const { DB, world, engine, tick } = await setup();
  const t0 = Date.now();
  const c = launch(world, engine, 'LATE', t0);
  trade(c, 40);
  for (let i = 1; i <= 8; i++) { trade(c, 0.5); await tick(t0 + i * 2000); }
  assert.equal(trades(DB).length, 0);
});

await test('dashboard Sell button sells a pump position at the curve price', async () => {
  const { DB, world, env, engine, tick } = await setup();
  const t0 = Date.now();
  const c = launch(world, engine, 'MANUAL', t0);
  for (let i = 1; i <= 8; i++) { trade(c, 0.5); await tick(t0 + i * 2000); }
  const ctx = await makeContext(env);
  const pos = await ctx.store.position('paper', 'MANUAL');
  const r = await sellPosition(ctx, pos, 'manual');
  assert.equal(r.ok, true);
  assert.equal(trades(DB)[1].reason, 'manual');
  assert.equal((await sellPosition(ctx, pos, 'manual')).ok, false, 'no double sell');
});

await test('pump mode refuses to trade live', async () => {
  const { DB, world, engine } = await setup();
  const t0 = Date.now();
  launch(world, engine, 'LIVE', t0);
  const env = { DB, STRATEGY: 'pump', JUP_RPS: '1000' };
  const ctx = await makeContext(env);
  ctx.cfg.LIVE = true;
  const r = await engine.tick(ctx, t0 + 2000);
  assert.equal(r.skipped, 'live');
  assert.match(events(DB), /paper-only/);
});

console.log(`\n${passed} pump tests passed`);
