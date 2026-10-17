// Offline tests for the pump.fun sniper: curve math, decoding, and full engine runs against
// simulated coins (mocked Solana RPC, Jupiter SOL price and coin metadata).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decodeCurve, curveBuy, curveSell, curveMcapSol, PumpEngine } from '../src/pump.js';
import { makeContext, sellPosition } from '../src/bot.js';
import { loadConfig } from '../src/strategy.js';
import { learn, predict, featuresOf, summarize, emptyModel } from '../src/learn.js';

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
  const { DB, world, engine, tick } = await setup({ PUMP_TAKE_PROFIT_USD: '0' });
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

await test('takes a $5 profit as soon as it is there', async () => {
  const { DB, world, engine, tick } = await setup();
  const t0 = Date.now();
  const c = launch(world, engine, 'TP', t0);
  let t = t0;
  for (let i = 1; i <= 8; i++) { t = t0 + i * 2000; trade(c, 0.5); await tick(t); }
  assert.equal(trades(DB).length, 1);
  for (let i = 0; i < 10 && trades(DB).length < 2; i++) { t += 2000; trade(c, 1); await tick(t); }
  const tr = trades(DB);
  assert.equal(tr[1].reason, 'take profit');
  assert.ok(tr[1].pnl_usd >= 5 && tr[1].pnl_usd < 9, `pnl ${tr[1].pnl_usd}`);
});

await test('scores every take-profit target on each coin it follows', async () => {
  const { DB, world, engine, tick } = await setup({ PUMP_MAX_POSITIONS: '0' });
  const t0 = Date.now();
  const c = launch(world, engine, 'BOARD', t0);
  let t = t0;
  for (let i = 1; i <= 8; i++) { t = t0 + i * 2000; trade(c, 0.5); await tick(t); }
  for (let i = 0; i < 6; i++) { t += 2000; trade(c, 2); await tick(t); } // runs up
  t += 2000; trade(c, -25); await tick(t); // then dumps through the stop
  const board = JSON.parse(DB.raw.prepare("SELECT v FROM state WHERE k='pump_tp_board'").get().v);
  assert.ok(board['10'].sum > 0.1, 'a 10% target would have banked a win');
  assert.ok(board.none.sum < -0.2, 'riding it out would have lost');
  assert.equal(board['25'].n, 1);
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

await test('does not skip a coin just because its metadata cannot be loaded', async () => {
  const { DB, world, engine, tick } = await setup();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (new URL(url).hostname === 'meta.test' ? new Response('down', { status: 503 }) : realFetch(url, init));
  const t0 = Date.now();
  const c = launch(world, engine, 'NOMETA', t0);
  for (let i = 1; i <= 8; i++) { trade(c, 0.5); await tick(t0 + i * 2000); }
  globalThis.fetch = realFetch;
  assert.equal(trades(DB).length, 1);
  assert.doesNotMatch(events(DB), /metadata unavailable/);
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

console.log('learning');
const young = featuresOf({ age: 12, inflow: 6, mcap: 41, rise: 9, devPct: 3, socials: 1, now: Date.UTC(2026, 9, 17, 2) });
const steady = featuresOf({ age: 110, inflow: 10, mcap: 51, rise: 2, devPct: 3, socials: 1, now: Date.UTC(2026, 9, 17, 2) });

await test('learns that young, fast-pumped coins lose and steady ones win', () => {
  let m = emptyModel();
  for (let i = 0; i < 20; i++) m = learn(m, { ...young, inflow: 5 + (i % 4) }, -0.33);
  for (let i = 0; i < 20; i++) m = learn(m, { ...steady, inflow: 9 + (i % 4) }, 0.25);
  const a = predict(m, young);
  const b = predict(m, steady);
  assert.ok(a.expected < -0.15, `young ${a.expected}`);
  assert.ok(b.expected > 0.1, `steady ${b.expected}`);
  assert.match(a.reasons[0].label, /age under 20s|buying speed|4s climb/);
  const sum = summarize(m);
  assert.equal(sum.lessons, 40);
  assert.ok(sum.worst.some((r) => /age under 20s/.test(r.label)));
});

await test('a couple of lucky trades cannot fool it', () => {
  let m = emptyModel();
  for (let i = 0; i < 40; i++) m = learn(m, steady, -0.2);
  m = learn(m, young, 3);
  m = learn(m, young, 3);
  assert.ok(predict(m, young).expected < 0.15, 'two moonshots barely move it');
});

await test('follows coins it skips (shadow trades) and learns from them', async () => {
  const { DB, world, engine, tick } = await setup({ PUMP_MAX_POSITIONS: '0' });
  const t0 = Date.now();
  const c = launch(world, engine, 'SHADOW', t0);
  let t = t0;
  for (let i = 1; i <= 8; i++) { t = t0 + i * 2000; trade(c, 0.5); await tick(t); }
  assert.equal(trades(DB).length, 0, 'no slots, so no real trade');
  assert.ok(engine.shadows.has('SHADOW'), 'followed as a shadow');
  t += 2000;
  trade(c, -6);
  await tick(t);
  assert.ok(!engine.shadows.has('SHADOW'));
  const model = JSON.parse(DB.raw.prepare("SELECT v FROM state WHERE k='pump_model_v2'").get().v);
  assert.equal(model.n, 1);
  assert.equal(model.shadow, 1);
  assert.ok(model.sum < -0.25, 'recorded as a big loss');
});

await test('real trades become lessons too', async () => {
  const { DB, world, engine, tick } = await setup();
  const t0 = Date.now();
  const c = launch(world, engine, 'REAL', t0);
  let t = t0;
  for (let i = 1; i <= 8; i++) { t = t0 + i * 2000; trade(c, 0.5); await tick(t); }
  t += 2000;
  trade(c, -6);
  await tick(t);
  const model = JSON.parse(DB.raw.prepare("SELECT v FROM state WHERE k='pump_model_v2'").get().v);
  assert.equal(model.real, 1);
});

await test('once trained, skips setups it has learned lose, and still buys ones that win', async () => {
  let m = emptyModel();
  for (let i = 0; i < 20; i++) m = learn(m, { ...young, age: 12 }, -0.33);
  for (let i = 0; i < 20; i++) m = learn(m, { ...young, age: 60 }, 0.3);
  const { DB, world, engine, tick } = await setup({ LEARN_MIN_LESSONS: '10', PUMP_MIN_INFLOW_SOL: '3' });
  DB.raw.prepare("INSERT INTO state (k, v) VALUES ('pump_model_v2', ?)").run(JSON.stringify(m));
  const t0 = Date.now();
  const fast = launch(world, engine, 'FAST', t0);
  for (let i = 1; i <= 8; i++) { trade(fast, 0.5); await tick(t0 + i * 2000); } // buyable at ~12s old
  assert.equal(trades(DB).length, 0, 'skipped the setup that keeps losing');
  assert.match(events(DB), /Skip FAST: learned this kind of setup loses/);
  assert.ok(engine.shadows.has('FAST'), 'still followed, so it can change its mind');

  const t1 = Date.now() + 60e3;
  const slow = launch(world, engine, 'SLOW', t1);
  for (let i = 1; i <= 30; i++) { trade(slow, i < 25 ? 0.12 : 0.6); await tick(t1 + i * 2000); } // ~60s old
  assert.equal(trades(DB).filter((x) => x.symbol === 'SLOW').length, 1, 'bought the setup that wins');
});

await test('metadata falls back to other IPFS gateways', async () => {
  const { DB, world, engine, tick } = await setup();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'ipfs.io') return new Response('slow', { status: 504 });
    if (u.hostname === 'gateway.pinata.cloud') return new Response(JSON.stringify({ twitter: 'x' }));
    return realFetch(url, init);
  };
  const t0 = Date.now();
  const c = launch(world, engine, 'IPFS', t0);
  engine.watch.get('IPFS').uri = 'https://ipfs.io/ipfs/QmTest';
  for (let i = 1; i <= 8; i++) { trade(c, 0.5); await tick(t0 + i * 2000); }
  assert.equal(trades(DB).length, 1);
  globalThis.fetch = realFetch;
});

await test('graduation waits for a full-size route, survives restart, and sells using USDC quote only', async () => {
  const { DB, world, env, engine, tick } = await setup();
  const t0 = Date.now();
  const c = launch(world, engine, 'GRAD', t0);
  for (let i = 1; i <= 8; i++) { trade(c, 0.5); await tick(t0 + i * 2000); }
  const ctx = await makeContext(env);
  const pos = await ctx.store.position('paper', 'GRAD');
  assert.ok(pos);
  const cash = await ctx.store.get('paper_cash');
  const realFetch = globalThis.fetch;
  let quote = { error: 'no route' };
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/swap/v2/order') {
      assert.equal(u.searchParams.get('inputMint'), 'GRAD');
      assert.equal(u.searchParams.get('outputMint'), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      assert.equal(u.searchParams.get('amount'), pos.qty_raw);
      assert.equal(u.searchParams.has('taker'), false, 'paper quote never signs');
      return new Response(JSON.stringify(quote));
    }
    return realFetch(url, init);
  };
  c.complete = true;
  await tick(t0 + 18000);
  assert.equal(trades(DB).length, 1, 'no fabricated graduation sale');
  assert.equal(await ctx.store.get('paper_cash'), cash);
  assert.ok(await ctx.store.position('paper', 'GRAD'));
  assert.equal(await ctx.store.get('pump_model_v2', null), null, 'no premature lesson');
  const manual = await sellPosition(ctx, pos, 'manual');
  assert.equal(manual.pending, true);
  assert.equal(events(DB).split('waiting for post-migration sell route').length - 1, 1, 'warnings rate limited');

  // Migration state is durable even if the curve disappears and the object restarts.
  delete world.curves['curve-GRAD'];
  const restarted = new PumpEngine(env);
  restarted.feedDisabled = true;
  quote = { inputMint: 'GRAD', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', inAmount: pos.qty_raw, outAmount: '40000000', transaction: null };
  for (const invalid of [{ outAmount: '0' }, { inAmount: '1' }, { outputMint: 'wrong' }, { errorCode: 3 }, { outAmount: 'NaN' }]) {
    const good = quote;
    quote = { ...good, ...invalid };
    await restarted.tick(await makeContext(env), t0 + 20000);
    assert.equal(trades(DB).length, 1, 'invalid route cannot close the position');
    quote = good;
  }
  await restarted.tick(await makeContext(env), t0 + 22000);
  const sale = trades(DB)[1];
  assert.equal(sale.reason, 'graduated');
  assert.equal(sale.usd, 38.8, 'quote less 3% haircut, no extra curve fees');
  assert.equal(await ctx.store.get('paper_cash'), cash + 38.8);
  assert.equal(await ctx.store.position('paper', 'GRAD'), null);
  assert.equal((await ctx.store.get('pump_model_v2')).real, 1);
  await restarted.tick(await makeContext(env), t0 + 24000);
  assert.equal(trades(DB).length, 2, 'sale recorded once');
});

await test('graduated shadows only become lessons when a migration sell quote exists', async () => {
  const { DB, world, env, engine, tick } = await setup();
  const ctx = await makeContext(env);
  await ctx.store.set('paused', true);
  const t0 = Date.now();
  const c = launch(world, engine, 'SHGRAD', t0);
  for (let i = 1; i <= 8; i++) { trade(c, 0.5); await tick(t0 + i * 2000); }
  assert.ok(engine.shadows.has('SHGRAD'));
  const sh = engine.shadows.get('SHGRAD');
  const realFetch = globalThis.fetch;
  let routed = false;
  globalThis.fetch = async (url, init) => {
    if (new URL(url).pathname === '/swap/v2/order') {
      if (!routed) return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify({ inputMint: 'SHGRAD', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', inAmount: sh.tokens.toString(), outAmount: '10000000' }));
    }
    return realFetch(url, init);
  };
  c.complete = true;
  await tick(t0 + 18000);
  assert.ok(engine.shadows.has('SHGRAD'));
  assert.equal(await ctx.store.get('pump_model_v2', null), null);
  delete world.curves['curve-SHGRAD'];
  routed = true;
  await tick(t0 + 20000);
  assert.equal(engine.shadows.has('SHGRAD'), false);
  const model = await ctx.store.get('pump_model_v2');
  assert.equal(model.shadow, 1);
  assert.ok(Math.abs(model.sum - (9.7 / 20 - 1)) < 1e-9);
  assert.equal(trades(DB).length, 0);
});

console.log(`\n${passed} pump tests passed`);

