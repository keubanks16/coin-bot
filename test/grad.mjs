// Offline tests for the graduated-coin trader: pool decoding, and full engine runs against
// simulated PumpSwap pools (mocked Solana RPC and Jupiter quotes).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decodePool, reservesOf, tokenAmount, GradEngine, AMM_PROGRAM } from '../src/grad.js';
import { PumpEngine } from '../src/pump.js';
import { makeContext, sellPosition } from '../src/bot.js';
import { b58encode } from '../src/solana.js';
import { SOL, USDC } from '../src/jupiter.js';

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

const key = () => b58encode(crypto.getRandomValues(new Uint8Array(32)));
const SOL_USD = 150;

function poolBytes({ mint, baseVault, quoteVault, vqr = 0n, quoteMint = SOL }) {
  const b = new Uint8Array(301);
  b.set([241, 154, 109, 4, 17, 177, 109, 188]);
  const put = (o, k) => b.set(Uint8Array.from(Buffer.from(k ? decode(k) : new Uint8Array(32))), o);
  put(43, mint);
  put(75, quoteMint);
  put(139, baseVault);
  put(171, quoteVault);
  const dv = new DataView(b.buffer);
  const v = vqr < 0n ? vqr + (1n << 128n) : vqr;
  dv.setBigUint64(245, v & ((1n << 64n) - 1n), true);
  dv.setBigUint64(253, v >> 64n, true);
  return b;
}
function tokenAccountBytes(amount) {
  const b = new Uint8Array(165);
  new DataView(b.buffer).setBigUint64(64, BigInt(amount), true);
  return b;
}
import { b58decode as decode } from '../src/solana.js';

/** A graduated coin's pool. trade(sol): someone buys (or sells, if negative) that much SOL. */
function newPool(world, mint) {
  const p = { mint, key: key(), baseVault: key(), quoteVault: key(), base: 206_900_000_000_000n, quote: 85_000_000_000n };
  world.pools[mint] = p;
  return {
    p,
    trade(sol) {
      const k = p.base * p.quote;
      p.quote += BigInt(Math.round(sol * 1e9));
      p.base = k / p.quote;
    },
  };
}

function installMock(world) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const reply = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (u.pathname === '/price/v3') return reply({ [SOL]: { usdPrice: SOL_USD } });
    if (u.pathname === '/swap/v2/order') {
      const inMint = u.searchParams.get('inputMint');
      const outMint = u.searchParams.get('outputMint');
      const amt = BigInt(u.searchParams.get('amount'));
      const pool = world.pools[inMint === USDC ? outMint : inMint];
      if (!pool || world.noRoute) return reply({ errorCode: 1, errorMessage: 'no route' });
      let out;
      if (inMint === USDC) {
        const lamports = (amt * 1000n) / BigInt(SOL_USD) * 99n / 100n; // $ -> SOL, 1% fee
        out = (pool.base * lamports) / (pool.quote + lamports);
      } else {
        const lamports = (pool.quote * amt) / (pool.base + amt) * 99n / 100n;
        out = (lamports * BigInt(SOL_USD)) / 1000n;
      }
      return reply({ inputMint: inMint, outputMint: outMint, inAmount: String(amt), outAmount: String(out), router: 'metis' });
    }
    if (u.hostname.includes('solana') || u.hostname.includes('publicnode')) {
      const body = JSON.parse(init.body);
      if (body.method === 'getProgramAccounts') {
        assert.equal(body.params[0], AMM_PROGRAM);
        const mint = body.params[1].filters[0].memcmp.bytes;
        const p = world.pools[mint];
        if (!p || world.hidePool) return reply({ result: [] });
        return reply({ result: [{ pubkey: p.key, account: { data: [Buffer.from(poolBytes({ mint, baseVault: p.baseVault, quoteVault: p.quoteVault })).toString('base64'), 'base64'] } }] });
      }
      if (body.method === 'getMultipleAccounts') {
        const value = body.params[0].map((k) => {
          for (const p of Object.values(world.pools)) {
            if (k === p.key) return { data: [Buffer.from(poolBytes({ mint: p.mint, baseVault: p.baseVault, quoteVault: p.quoteVault })).toString('base64'), 'base64'] };
            if (k === p.baseVault) return { data: [Buffer.from(tokenAccountBytes(p.base)).toString('base64'), 'base64'] };
            if (k === p.quoteVault) return { data: [Buffer.from(tokenAccountBytes(p.quote)).toString('base64'), 'base64'] };
          }
          return null;
        });
        return reply({ result: { value } });
      }
    }
    return new Response('not mocked: ' + url, { status: 404 });
  };
}

async function setup(extraEnv = {}) {
  const DB = makeD1();
  const world = { pools: {} };
  installMock(world);
  const env = { DB, STRATEGY: 'pump', JUP_RPS: '1000', ...extraEnv };
  const engine = new GradEngine(env);
  const tick = async (t, opts = {}) => engine.tick(await makeContext(env), t, { solUsd: SOL_USD, paused: false, halted: false, ...opts });
  return { DB, world, env, engine, tick };
}
const trades = (DB) => DB.raw.prepare('SELECT side, symbol, usd, pnl_usd, reason FROM trades ORDER BY id').all();
const events = (DB) => DB.raw.prepare('SELECT msg FROM events ORDER BY id').all().map((e) => e.msg).join('\n');

/** Graduate a coin and run `seconds` of 2-second ticks with `perTick` SOL of buying each. */
async function run(ctx, mint, t0, seconds, perTick, pool) {
  let t = t0;
  for (let s = 2; s <= seconds; s += 2) {
    t = t0 + s * 1000;
    pool.trade(perTick);
    await ctx.tick(t);
  }
  return t;
}

console.log('graduated coins: data');
await test('decodes a PumpSwap pool and its vault balances', () => {
  const mint = key(), bv = key(), qv = key();
  const p = decodePool(poolBytes({ mint, baseVault: bv, quoteVault: qv }));
  assert.equal(p.baseMint, mint);
  assert.equal(p.quoteMint, SOL);
  assert.equal(p.baseVault, bv);
  assert.equal(p.quoteVault, qv);
  assert.equal(tokenAmount(tokenAccountBytes(12345n)), 12345n);
  assert.equal(decodePool(new Uint8Array(301)), null, 'wrong discriminator');
});

await test('handles negative virtual quote reserves', () => {
  const mint = key();
  const pb = poolBytes({ mint, baseVault: key(), quoteVault: key(), vqr: -5_000_000_000n });
  assert.equal(decodePool(pb).vqr, -5_000_000_000n);
  const r = reservesOf(pb, tokenAccountBytes(1_000_000n), tokenAccountBytes(85_000_000_000n));
  assert.equal(r.quote, 80_000_000_000n);
});

console.log('graduated coins: engine');
await test('waits out the first minute, buys a graduate with steady buying, takes $5 profit', async () => {
  const ctx = await setup();
  const mint = key();
  const pool = newPool(ctx.world, mint);
  const t0 = Date.now();
  ctx.engine.handleMigration({ txType: 'migrate', mint }, t0, 'GRAD');
  let t = await run(ctx, mint, t0, 50, 0.6, pool); // heavy buying, but too soon
  assert.equal(trades(ctx.DB).length, 0, 'no buy in the first minute');
  t = await run(ctx, mint, t, 20, 0.15, pool); // steady buying a minute in
  let tr = trades(ctx.DB);
  assert.equal(tr.length, 1, 'bought once');
  assert.equal(tr[0].side, 'buy');
  assert.match(tr[0].reason, /^grad: graduated \d+s ago/);
  for (let i = 0; i < 40 && trades(ctx.DB).length < 2; i++) { t += 2000; pool.trade(1.5); await ctx.tick(t); }
  tr = trades(ctx.DB);
  assert.equal(tr[1].reason, 'grad: take profit');
  assert.ok(tr[1].pnl_usd >= 5 && tr[1].pnl_usd < 8, `pnl ${tr[1].pnl_usd}`);
  assert.match(events(ctx.DB), /SELL GRAD \(graduated\).*Jupiter quote/);
});

await test('cuts a graduate that dumps after the buy', async () => {
  const ctx = await setup();
  const mint = key();
  const pool = newPool(ctx.world, mint);
  const t0 = Date.now();
  ctx.engine.handleMigration({ txType: 'migrate', mint }, t0, 'DUMP');
  let t = await run(ctx, mint, t0, 70, 0.15, pool);
  assert.equal(trades(ctx.DB).length, 1);
  t += 2000;
  pool.trade(-20);
  await ctx.tick(t);
  const tr = trades(ctx.DB);
  assert.equal(tr[1].reason, 'grad: stop loss');
  assert.ok(tr[1].pnl_usd < -3);
});

await test('ignores graduates nobody is buying', async () => {
  const ctx = await setup();
  const mint = key();
  const pool = newPool(ctx.world, mint);
  const t0 = Date.now();
  ctx.engine.handleMigration({ txType: 'migrate', mint }, t0, 'DEAD');
  await run(ctx, mint, t0, 120, 0, pool);
  assert.equal(trades(ctx.DB).length, 0);
});

await test('follows graduates it skips and scores every profit target', async () => {
  const ctx = await setup({ GRAD_MAX_POSITIONS: '0' });
  const mint = key();
  const pool = newPool(ctx.world, mint);
  const t0 = Date.now();
  ctx.engine.handleMigration({ txType: 'migrate', mint }, t0, 'SHAD');
  let t = await run(ctx, mint, t0, 70, 0.15, pool);
  assert.ok(ctx.engine.shadows.has(mint));
  for (let i = 0; i < 5; i++) { t += 2000; pool.trade(1.5); await ctx.tick(t); }
  t += 2000;
  pool.trade(-30);
  await ctx.tick(t);
  assert.ok(!ctx.engine.shadows.has(mint));
  const board = JSON.parse(ctx.DB.raw.prepare("SELECT v FROM state WHERE k='grad_tp_board'").get().v);
  assert.ok(board['5'].sum > 0, 'a 5% target would have banked a win');
  assert.ok(board.none.sum < 0, 'riding it would have lost');
  const model = JSON.parse(ctx.DB.raw.prepare("SELECT v FROM state WHERE k='grad_model'").get().v);
  assert.equal(model.shadow, 1);
});

await test('keeps looking for the pool until it appears', async () => {
  const ctx = await setup();
  const mint = key();
  const pool = newPool(ctx.world, mint);
  ctx.world.hidePool = true;
  const t0 = Date.now();
  ctx.engine.handleMigration({ txType: 'migrate', mint }, t0, 'SLOW');
  await ctx.tick(t0 + 2000);
  assert.equal(ctx.engine.coins.get(mint).pool, null);
  ctx.world.hidePool = false;
  await ctx.tick(t0 + 8000);
  assert.equal(ctx.engine.coins.get(mint).pool.pool, pool.p.key);
});

await test('dashboard Sell button sells a graduated position', async () => {
  const ctx = await setup();
  const mint = key();
  const pool = newPool(ctx.world, mint);
  const t0 = Date.now();
  ctx.engine.handleMigration({ txType: 'migrate', mint }, t0, 'MAN');
  await run(ctx, mint, t0, 70, 0.15, pool);
  const c = await makeContext(ctx.env);
  const pos = await c.store.position('paper', mint);
  assert.ok(pos);
  const r = await sellPosition(c, pos, 'manual');
  assert.equal(r.ok, true);
  assert.equal(trades(ctx.DB)[1].reason, 'grad: manual');
});

await test('the sniper feed hands graduations to this strategy, with the coin name', () => {
  const pe = new PumpEngine({});
  const mint = key();
  pe.handleMessage({ txType: 'create', mint, symbol: 'NAMED', bondingCurveKey: key(), initialBuy: 0, vSolInBondingCurve: 30 }, Date.now(), { PUMP_MAX_DEV_PCT: 10 });
  pe.handleMessage({ txType: 'migrate', mint, pool: 'pump-amm' }, Date.now());
  assert.equal(pe.grad.coins.get(mint).symbol, 'NAMED');
});

console.log(`\n${passed} graduated-coin tests passed`);
