// Offline tests: signing, strategy rules, and full paper + live cycles against a
// mocked Jupiter/RPC and an in-memory SQLite stand-in for D1.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { b58encode, b58decode, b64encode, b64decode, loadKeypair, signTransaction } from '../src/solana.js';
import { loadConfig, safetyReject, entryScore, exitDecision, positionSize, costReject } from '../src/strategy.js';
import { runCycle } from '../src/bot.js';
import { USDC } from '../src/jupiter.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ✓', name);
}

// ---- D1 shim -------------------------------------------------------------
function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())), raw: db };
}

// ---- helpers -------------------------------------------------------------
async function newWallet() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const seed = pkcs8.slice(-32);
  const full = new Uint8Array(64);
  full.set(seed);
  full.set(pub, 32);
  return { secret: b58encode(full), pub, verifyKey: kp.publicKey };
}

function fakeV0Tx(signerKeys, extraKeys = 2) {
  const keys = [...signerKeys];
  for (let i = 0; i < extraKeys; i++) keys.push(crypto.getRandomValues(new Uint8Array(32)));
  const body = [0x80, signerKeys.length, 0, 1, keys.length, ...keys.flatMap((k) => [...k]), ...crypto.getRandomValues(new Uint8Array(40))];
  const msg = Uint8Array.from(body);
  const tx = new Uint8Array(1 + signerKeys.length * 64 + msg.length);
  tx[0] = signerKeys.length;
  tx.set(msg, 1 + signerKeys.length * 64);
  return { b64: b64encode(tx), msg };
}

const HOUR = 3600e3;
function goodToken(over = {}) {
  return {
    id: 'GoodMint11111111111111111111111111111111111',
    symbol: 'GOOD',
    decimals: 6,
    usdPrice: 0.5,
    liquidity: 900000,
    mcap: 20000000,
    organicScore: 85,
    isVerified: true,
    tags: ['verified'],
    firstPool: { createdAt: new Date(Date.now() - 30 * 24 * HOUR).toISOString() },
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18 },
    stats5m: { priceChange: 1.2, buyVolume: 40000, sellVolume: 20000, buyOrganicVolume: 15000, sellOrganicVolume: 8000, numNetBuyers: 30 },
    stats1h: { priceChange: 9, buyVolume: 400000, sellVolume: 250000, buyOrganicVolume: 90000, sellOrganicVolume: 50000, numNetBuyers: 120 },
    ...over,
  };
}

// ---- tests ---------------------------------------------------------------
console.log('solana');
await test('base58 round trip incl. leading zeros', () => {
  const b = Uint8Array.from([0, 0, 1, 2, 255, 128, 7]);
  assert.deepEqual(b58decode(b58encode(b)), b);
  assert.equal(b58encode(b58decode('11StV1DL6CwTryKyV')).toString(), '11StV1DL6CwTryKyV');
});

await test('loads a Phantom-style key and signs the right slot', async () => {
  const w = await newWallet();
  const kp = await loadKeypair(w.secret);
  assert.equal(kp.publicKey, b58encode(w.pub));
  const otherSigner = crypto.getRandomValues(new Uint8Array(32)); // e.g. Jupiter gasless payer in slot 0
  const { b64, msg } = fakeV0Tx([otherSigner, w.pub]);
  const signed = b64decode(await signTransaction(b64, kp));
  const slot0 = signed.slice(1, 65);
  const slot1 = signed.slice(65, 129);
  assert.ok(slot0.every((b) => b === 0), 'slot 0 must be untouched');
  assert.ok(await crypto.subtle.verify({ name: 'Ed25519' }, w.verifyKey, slot1, msg), 'signature verifies');
  assert.deepEqual(signed.slice(129), msg, 'message unchanged');
});

await test('refuses to sign a transaction we are not a signer on', async () => {
  const w = await newWallet();
  const kp = await loadKeypair(w.secret);
  const { b64 } = fakeV0Tx([crypto.getRandomValues(new Uint8Array(32))]);
  await assert.rejects(signTransaction(b64, kp), /not a required signer/);
});

await test('rejects a mismatched key', async () => {
  const a = await newWallet();
  const b = await newWallet();
  const bad = new Uint8Array(64);
  bad.set(b58decode(a.secret).slice(0, 32));
  bad.set(b.pub, 32);
  await assert.rejects(loadKeypair(b58encode(bad)), /do not match/);
});

console.log('strategy');
const cfg = loadConfig({});
await test('safety filter', () => {
  assert.equal(safetyReject(goodToken(), cfg), null);
  assert.equal(safetyReject(goodToken({ audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true } }), cfg), 'mint authority active');
  assert.equal(safetyReject(goodToken({ audit: { isSus: true, mintAuthorityDisabled: true, freezeAuthorityDisabled: true } }), cfg), 'flagged suspicious');
  assert.equal(safetyReject(goodToken({ liquidity: 1000 }), cfg), 'low liquidity');
  assert.equal(safetyReject(goodToken({ firstPool: { createdAt: new Date().toISOString() } }), cfg), 'too new');
  assert.equal(safetyReject(goodToken({ isVerified: false, organicScore: 20 }), cfg), 'low organic score');
  assert.equal(safetyReject(goodToken({ id: USDC }), cfg), 'excluded');
});

await test('scalp entry signal', () => {
  assert.equal(cfg.STRATEGY, 'scalp');
  assert.ok(entryScore(goodToken(), cfg) > 0);
  assert.equal(entryScore(goodToken({ stats1h: { ...goodToken().stats1h, priceChange: 60 } }), cfg), null, 'too extended');
  assert.equal(entryScore(goodToken({ stats5m: { ...goodToken().stats5m, priceChange: -1 } }), cfg), null, 'falling now');
  assert.equal(entryScore(goodToken({ stats5m: { ...goodToken().stats5m, priceChange: 9 } }), cfg), null, 'vertical spike');
  assert.equal(entryScore(goodToken({ stats5m: { ...goodToken().stats5m, buyOrganicVolume: 10, sellOrganicVolume: 100 } }), cfg), null, 'sellers dominate 5m');
  assert.equal(entryScore(goodToken({ stats5m: { ...goodToken().stats5m, buyVolume: 1000, sellVolume: 1000 } }), cfg), null, 'no 5m volume');
});

const mcfg = loadConfig({ STRATEGY: 'momentum' });
await test('momentum entry signal still works', () => {
  assert.equal(mcfg.STRATEGY, 'momentum');
  assert.ok(entryScore(goodToken(), mcfg) > 0);
  assert.equal(entryScore(goodToken({ stats1h: { ...goodToken().stats1h, buyOrganicVolume: 10, sellOrganicVolume: 100 } }), mcfg), null, 'sellers dominate 1h');
});

await test('round-trip cost check', () => {
  assert.equal(costReject(100, 99.6, cfg), null, '0.4% is fine');
  assert.match(costReject(100, 98.5, cfg), /too high/);
  assert.match(costReject(100, 0, cfg), /no route/);
  assert.match(costReject(100, 99.4, loadConfig({ TAKE_PROFIT_PCT: '0.01' })), /take profit too small/);
});

await test('scalp exit rules', () => {
  const now = Date.now();
  const pos = { entry_price: 1, peak_price: 1, opened_at: now - 5 * 60e3 };
  assert.equal(exitDecision(pos, 0.97, cfg, now).reason, 'stop loss');
  assert.equal(exitDecision(pos, 1.05, cfg, now).reason, 'take profit');
  assert.equal(exitDecision({ ...pos, peak_price: 1.03 }, 1.019, cfg, now).reason, 'trailing stop');
  assert.equal(exitDecision({ ...pos, peak_price: 1.03 }, 1.025, cfg, now).sell, false);
  assert.equal(exitDecision({ ...pos, opened_at: now - 16 * 60e3 }, 1.002, cfg, now).reason, 'no momentum');
  assert.equal(exitDecision({ ...pos, opened_at: now - 16 * 60e3 }, 1.01, cfg, now).sell, false);
  assert.equal(exitDecision({ ...pos, opened_at: now - 61 * 60e3 }, 1.01, cfg, now).reason, 'max hold time');
  assert.equal(exitDecision(pos, 1.005, cfg, now).sell, false);
});

await test('momentum exit rules', () => {
  const now = Date.now();
  const pos = { entry_price: 1, peak_price: 1, opened_at: now - HOUR };
  assert.equal(exitDecision(pos, 0.91, mcfg, now).reason, 'stop loss');
  assert.equal(exitDecision(pos, 1.3, mcfg, now).reason, 'take profit');
  assert.equal(exitDecision({ ...pos, peak_price: 1.15 }, 1.07, mcfg, now).reason, 'trailing stop');
  assert.equal(exitDecision({ ...pos, peak_price: 1.15 }, 1.12, mcfg, now).sell, false);
  assert.equal(exitDecision({ ...pos, opened_at: now - 25 * HOUR }, 1.01, mcfg, now).reason, 'max hold time');
});

await test('position sizing', () => {
  assert.equal(positionSize(1000, 1000, cfg), 150);
  assert.equal(positionSize(10000, 10000, cfg), 250);
  assert.equal(positionSize(1000, 4, cfg), 0);
});

// ---- mocked network ------------------------------------------------------
function installMock(market) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const reply = (obj) => new Response(JSON.stringify(obj), { status: 200 });
    market.calls.push(u.pathname);
    if (u.pathname.startsWith('/tokens/v2/')) return reply(market.tokens);
    if (u.pathname === '/price/v3') {
      const out = {};
      for (const id of u.searchParams.get('ids').split(',')) if (market.prices[id]) out[id] = { usdPrice: market.prices[id] * (1 + (market.apiBoost || 0)), decimals: 6 };
      return reply(out);
    }
    if (u.pathname === '/swap/v2/order') {
      const inMint = u.searchParams.get('inputMint');
      const outMint = u.searchParams.get('outputMint');
      const amt = Number(u.searchParams.get('amount'));
      // USDC (6dp) <-> token (6dp) at the token's current price
      const p = market.prices[inMint === USDC ? outMint : inMint];
      const out = inMint === USDC ? Math.floor(amt / p) : Math.floor(amt * p * (1 - (market.spread || 0)));
      const o = { requestId: 'req-' + market.calls.length, outAmount: String(out), router: 'metis' };
      if (u.searchParams.get('taker')) {
        o.transaction = fakeV0Tx([market.walletPub]).b64;
        market.lastOrder = { inMint, amt, out };
      } else o.transaction = null;
      return reply(o);
    }
    if (u.pathname === '/swap/v2/execute') {
      const body = JSON.parse(init.body);
      const tx = b64decode(body.signedTransaction);
      const ok = await crypto.subtle.verify({ name: 'Ed25519' }, market.verifyKey, tx.slice(1, 65), tx.slice(65));
      market.executed.push(ok);
      const { amt, out } = market.lastOrder;
      return reply(ok
        ? { status: 'Success', code: 0, signature: 'sig' + market.executed.length, totalInputAmount: String(amt), totalOutputAmount: String(out) }
        : { status: 'Failed', code: -1003, error: 'bad sig' });
    }
    if (u.hostname === 'api.mainnet-beta.solana.com') {
      const body = JSON.parse(init.body);
      if (body.method === 'getBalance') return reply({ result: { value: 0.1e9 } });
      if (body.method === 'getTokenAccountsByOwner') {
        const mint = body.params[1].mint;
        const amount = String(market.balances[mint] || 0);
        return reply({ result: { value: amount === '0' ? [] : [{ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } }] } });
      }
    }
    return new Response('not mocked: ' + url, { status: 404 });
  };
}

const good = goodToken();
const junk = goodToken({ id: 'JunkMint1111111111111111111111111111111111', symbol: 'JUNK', audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: false } });

console.log('paper cycle');
await test('buys the good token, skips the junk, then takes profit', async () => {
  const DB = makeD1();
  const market = { calls: [], tokens: [good, junk], prices: { [good.id]: 0.5, [junk.id]: 1 } };
  installMock(market);
  const env = { DB, JUPITER_API_KEY: 'k', JUP_RPS: '1000' };

  const r1 = await runCycle(env, { forceScan: true });
  assert.equal(r1.bought, 1);
  let pos = DB.raw.prepare('SELECT * FROM positions').all();
  assert.equal(pos.length, 1);
  assert.equal(pos[0].symbol, 'GOOD');
  assert.equal(pos[0].cost_usd, 150);
  const cashAfterBuy = JSON.parse(DB.raw.prepare("SELECT v FROM state WHERE k='paper_cash'").get().v);
  assert.equal(cashAfterBuy, 850);

  // A +30% move should trigger take profit on the next cycle.
  market.prices[good.id] = 0.65;
  const r2 = await runCycle(env);
  assert.equal(r2.positions, 0);
  const sell = DB.raw.prepare("SELECT * FROM trades WHERE side='sell'").get();
  assert.equal(sell.reason, 'take profit');
  assert.ok(sell.pnl_usd > 40 && sell.pnl_usd < 45, `pnl ${sell.pnl_usd}`);

  // Cooldown: should not rebuy immediately even though the signal still fires.
  const r3 = await runCycle(env, { forceScan: true });
  assert.equal(r3.bought, 0);
});

await test('stop loss and daily loss limit', async () => {
  const DB = makeD1();
  const market = { calls: [], tokens: [good], prices: { [good.id]: 0.5 } };
  installMock(market);
  const env = { DB, JUPITER_API_KEY: 'k', JUP_RPS: '1000', POSITION_PCT: '1', MAX_TRADE_USD: '2000', MAX_POSITIONS: '1' };
  await runCycle(env, { forceScan: true });
  market.prices[good.id] = 0.4; // -20%
  await runCycle(env);
  const sell = DB.raw.prepare("SELECT * FROM trades WHERE side='sell'").get();
  assert.equal(sell.reason, 'stop loss');
  const events = DB.raw.prepare('SELECT msg FROM events').all().map((e) => e.msg).join('\n');
  assert.match(events, /Daily loss limit hit/);
});

await test('skips tokens that are too expensive to round-trip', async () => {
  const DB = makeD1();
  installMock({ calls: [], tokens: [good], prices: { [good.id]: 0.5 }, spread: 0.02 });
  const r = await runCycle({ DB, JUP_RPS: '1000' }, { forceScan: true });
  assert.equal(r.bought, 0);
  const events = DB.raw.prepare('SELECT msg FROM events').all().map((e) => e.msg).join('\n');
  assert.match(events, /Skip GOOD: round-trip cost 2\.00% too high/);
});

await test('exits use the real sell quote, not the display price', async () => {
  const DB = makeD1();
  const market = { calls: [], tokens: [good], prices: { [good.id]: 0.5 } };
  installMock(market);
  const env = { DB, JUP_RPS: '1000' };
  await runCycle(env, { forceScan: true });
  // Display price says +6% (would trigger take profit), but selling really returns about break-even.
  market.apiBoost = 0.06;
  market.prices[good.id] = 0.502;
  const r = await runCycle(env);
  assert.equal(r.positions, 1, 'must not "take profit" on a gain it cannot actually sell for');
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM trades WHERE side='sell'").get().n, 0);
});

await test('a losing token gets a long cooldown', async () => {
  const DB = makeD1();
  const market = { calls: [], tokens: [good], prices: { [good.id]: 0.5 } };
  installMock(market);
  const env = { DB, JUP_RPS: '1000', LOSS_STREAK_LIMIT: '0' };
  await runCycle(env, { forceScan: true });
  market.prices[good.id] = 0.48; // -4% -> stop loss
  await runCycle(env);
  const until = DB.raw.prepare('SELECT until FROM cooldowns').get().until;
  assert.ok(until - Date.now() > 3.9 * HOUR, 'about 4 hours');
});

await test('losing streak pauses new buys', async () => {
  const DB = makeD1();
  installMock({ calls: [], tokens: [good], prices: { [good.id]: 0.5 } });
  const ins = DB.raw.prepare("INSERT INTO trades (ts, mode, side, mint, symbol, usd, pnl_usd) VALUES (?, 'paper', 'sell', 'x', 'X', 10, -1)");
  for (let i = 0; i < 4; i++) ins.run(Date.now() - 60e3);
  const r = await runCycle({ DB, JUP_RPS: '1000' }, { forceScan: true });
  assert.equal(r.bought, 0);
  assert.equal(r.cooling, true);
});

await test('pause stops new buys', async () => {
  const DB = makeD1();
  installMock({ calls: [], tokens: [good], prices: { [good.id]: 0.5 } });
  DB.raw.prepare("INSERT INTO state (k, v) VALUES ('paused', 'true')").run();
  const r = await runCycle({ DB, JUP_RPS: '1000' }, { forceScan: true });
  assert.equal(r.bought, 0);
});

console.log('live cycle (mocked chain)');
await test('signs and executes real-mode swaps', async () => {
  const w = await newWallet();
  const DB = makeD1();
  const market = {
    calls: [], executed: [], tokens: [good], prices: { [good.id]: 0.5 },
    walletPub: w.pub, verifyKey: w.verifyKey,
    balances: { [USDC]: 500_000_000 }, // $500
  };
  installMock(market);
  const env = { DB, JUPITER_API_KEY: 'k', JUP_RPS: '1000', LIVE_TRADING: 'true', WALLET_PRIVATE_KEY: w.secret };
  const r = await runCycle(env, { forceScan: true });
  assert.equal(r.mode, 'live');
  assert.equal(r.bought, 1);
  assert.deepEqual(market.executed, [true]);
  const pos = DB.raw.prepare('SELECT * FROM positions').get();
  assert.equal(pos.mode, 'live');
  assert.equal(pos.cost_usd, 75); // 15% of $500

  market.balances[good.id] = Number(pos.qty_raw);
  market.prices[good.id] = 0.44; // -12%
  await runCycle(env);
  assert.deepEqual(market.executed, [true, true]);
  const sell = DB.raw.prepare("SELECT * FROM trades WHERE side='sell'").get();
  assert.equal(sell.reason, 'stop loss');
  assert.equal(sell.sig, 'sig2');
});

console.log(`\n${passed} tests passed`);
