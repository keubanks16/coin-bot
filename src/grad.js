// Graduated-coin trader (runs next to the pump.fun sniper when GRAD_ENABLED = 1). Paper only.
//
// When a pump.fun coin "graduates" it moves off its launch curve into a PumpSwap pool, where it
// trades like any Solana token (Jupiter / Phantom can swap it). The first moments are a frenzy of
// snipers and early holders cashing out, so this strategy waits, then buys only coins that are
// still getting real buying after that, and takes a small profit.
//
// 1. PumpPortal's free feed announces each graduation (same WebSocket as the sniper).
// 2. It finds the coin's PumpSwap pool on-chain, then reads the pool's SOL and token balances
//    every couple of seconds (batched with the sniper's reads) to see buying and price.
// 3. Buys are priced with a real Jupiter quote (fees and price impact included) plus a small
//    paper haircut; exits are watched from the pool's balances and sold with a real Jupiter quote.
// 4. Like the sniper, every candidate it doesn't buy is followed as a shadow trade, scored against
//    several profit targets, and used to learn which setups work (separate model and scoreboard).

import { SOL, USDC, USDC_DECIMALS } from './jupiter.js';
import { b58encode } from './solana.js';
import { GRAD_FEATURES, learn, predict, summarize } from './learn.js';

export const AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];
const TOKEN_DECIMALS = 6;
const MODEL_KEY = 'grad_model';
const BOARD_KEY = 'grad_tp_board';
const poolKeyName = (mint) => `grad_pool_${mint}`;
const featKeyName = (mint) => `grad_feat_${mint}`;
export const TP_LEVELS = [0.05, 0.1, 0.15, 0.25, 0.4];
const tpKey = (l) => (l === null ? 'none' : String(Math.round(l * 100)));
const fmt = (n) => `$${Number(n).toFixed(2)}`;
const haircut = (x, bps) => (BigInt(x) * BigInt(10000 - bps)) / 10000n;

// ---- on-chain data ----------------------------------------------------------------------

/** Decode a PumpSwap Pool account (layout from pump.fun's published IDL). Null if it isn't one. */
export function decodePool(bytes) {
  if (!bytes || bytes.length < 203) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== POOL_DISCRIMINATOR[i]) return null;
  const key = (o) => b58encode(bytes.slice(o, o + 32));
  let vqr = 0n; // virtual_quote_reserves (i128, may be negative); absent on older pools
  if (bytes.length >= 261) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    vqr = dv.getBigUint64(245, true) | (dv.getBigUint64(253, true) << 64n);
    if (vqr >= 1n << 127n) vqr -= 1n << 128n;
  }
  return { baseMint: key(43), quoteMint: key(75), baseVault: key(139), quoteVault: key(171), vqr };
}

/** Raw amount held by an SPL token account (same offset for Token and Token-2022). */
export function tokenAmount(bytes) {
  if (!bytes || bytes.length < 72) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true);
}

/** Pool reserves from the three accounts. quote is effective SOL reserves in lamports. */
export function reservesOf(poolBytes, baseBytes, quoteBytes) {
  const pool = decodePool(poolBytes);
  const base = tokenAmount(baseBytes);
  const rawQuote = tokenAmount(quoteBytes);
  if (!pool || base === null || rawQuote === null || base <= 0n) return null;
  const quote = rawQuote + pool.vqr;
  if (quote <= 0n) return null;
  return { base, quote };
}

export const poolPriceSol = (r) => Number(r.quote) / 1e9 / (Number(r.base) / 10 ** TOKEN_DECIMALS);

/** Lamports out for selling `tokens` into the pool, after the fee. */
export function ammSell(r, tokens, feeBps) {
  const t = BigInt(tokens);
  if (t <= 0n) return 0n;
  const gross = (r.quote * t) / (r.base + t);
  return (gross * BigInt(10000 - feeBps)) / 10000n;
}

/** Tokens out for `lamports` in, after the fee. */
export function ammBuy(r, lamports, feeBps) {
  const net = (BigInt(lamports) * BigInt(10000 - feeBps)) / 10000n;
  if (net <= 0n) return 0n;
  return (r.base * net) / (r.quote + net);
}

// ---- rules -------------------------------------------------------------------------------

/** Buy now? Returns { score, ... } to buy, 'dead' to stop watching, or null to keep watching. */
export function gradEntry(c, r, cfg, now) {
  const since = (now - c.migratedAt) / 1000;
  if (since > cfg.GRAD_MAX_AGE_MIN * 60) return 'dead';
  const liq = Number(r.quote) / 1e9;
  if (since < cfg.GRAD_MIN_WAIT_SEC) return null;
  if (liq < cfg.GRAD_MIN_LIQ_SOL) return since > 180 ? 'dead' : null;
  const price = poolPriceSol(r);
  // SOL added to the pool over the last minute = net buying.
  const minuteAgo = c.hist.find((h) => now - h.t <= 62e3);
  if (!minuteAgo || now - minuteAgo.t < 40e3) return null;
  const inflow = liq - minuteAgo.liq;
  if (inflow < cfg.GRAD_MIN_INFLOW_SOL) return null;
  // Climbing right now: price vs ~10 seconds ago.
  const prev = [...c.hist].reverse().find((h) => now - h.t >= 9e3);
  if (!prev) return null;
  const rise = (price / prev.price - 1) * 100;
  if (rise < cfg.GRAD_MIN_TICK_RISE_PCT) return null;
  const dip = (1 - price / c.peak) * 100;
  if (dip > cfg.GRAD_MAX_DIP_PCT) return null;
  return { score: inflow, since, inflow, liq, rise, dip: Math.max(dip, 0) };
}

/** Sell now? `value` is what selling the whole position would bring (USD, after fees). */
export function gradExit(pos, value, peakValue, lastUpAt, cfg, now, takeProfitPct = null) {
  const pnl = value / pos.cost - 1;
  const peakGain = peakValue / pos.cost - 1;
  if (takeProfitPct !== null && pnl >= takeProfitPct) return 'take profit';
  if (pnl <= -cfg.GRAD_STOP_LOSS_PCT) return 'stop loss';
  if (peakGain >= cfg.GRAD_TRAIL_ARM_PCT && value <= peakValue * (1 - cfg.GRAD_DOWNTURN_PCT)) return 'first downturn';
  if (now - lastUpAt >= cfg.GRAD_STALL_SEC * 1000) return 'stalled';
  if (now - pos.opened_at >= cfg.GRAD_MAX_HOLD_MIN * 60e3) return 'max hold time';
  return null;
}

const activeTp = (cfg, cost) => (cfg.GRAD_TAKE_PROFIT_USD > 0 ? cfg.GRAD_TAKE_PROFIT_USD / cost : null);

/** Value in USD of selling `tokens` into the pool now, with fees and the paper haircut. */
function poolValueUsd(r, tokens, cfg, solUsd) {
  return (Number(haircut(ammSell(r, tokens, cfg.GRAD_FEE_BPS), cfg.GRAD_PAPER_SLIPPAGE_BPS)) / 1e9) * solUsd;
}

// ---- money and memory ---------------------------------------------------------------------

async function adjustPaperCash(ctx, delta) {
  const cash = await ctx.store.get('paper_cash', ctx.cfg.PAPER_START_USD);
  await ctx.store.set('paper_cash', Math.round((cash + delta) * 1e6) / 1e6);
}

const validQuote = (q, inMint, outMint, amount) =>
  q && !q.error && q.errorCode == null && q.inputMint === inMint && q.outputMint === outMint &&
  /^\d+$/.test(String(q.inAmount)) && BigInt(q.inAmount) === BigInt(amount) &&
  /^\d+$/.test(String(q.outAmount)) && BigInt(q.outAmount) > 0n;

/** Real Jupiter sell quote for the whole holding, in USD after the paper haircut. */
async function quoteSellUsd(ctx, mint, qtyRaw) {
  const q = await ctx.jup.order({ inputMint: mint, outputMint: USDC, amount: String(qtyRaw) });
  if (!validQuote(q, mint, USDC, qtyRaw)) throw new Error('no valid sell quote');
  return Number(haircut(BigInt(q.outAmount), ctx.cfg.GRAD_PAPER_SLIPPAGE_BPS)) / 10 ** USDC_DECIMALS;
}

async function saveLesson(store, feats, ret, kind) {
  const model = learn(await store.get(MODEL_KEY, null), feats, ret, kind, GRAD_FEATURES);
  await store.set(MODEL_KEY, model);
  return model;
}

async function saveBoard(store, results) {
  const board = (await store.get(BOARD_KEY, null)) || {};
  for (const [k, r] of Object.entries(results)) {
    const b = (board[k] ||= { n: 0, sum: 0, wins: 0 });
    b.n++;
    b.sum += r;
    if (r > 0) b.wins++;
  }
  await store.set(BOARD_KEY, board);
  return board;
}

function boardRows(board, tradeUsd, activePct) {
  if (!board) return [];
  return Object.entries(board)
    .map(([k, b]) => ({ target: k === 'none' ? null : Number(k), n: b.n, avg: b.sum / b.n, usd: (b.sum / b.n) * tradeUsd, winRate: b.wins / b.n, active: k === tpKey(activePct) }))
    .sort((a, b) => (a.target ?? 1e9) - (b.target ?? 1e9));
}

/** Sell a graduated-coin position (also used by the dashboard's Sell buttons). */
export async function sellGradPosition(ctx, pos, reason, reserves = null, solUsd = null) {
  const { store, mode, cfg } = ctx;
  if (cfg.LIVE) return { ok: false, error: 'graduated-coin trading is paper-only' };
  if (!(await store.position(mode, pos.mint))) return { ok: false, error: 'already sold' };
  const qty = BigInt(pos.qty_raw);
  let proceeds;
  let how = 'Jupiter quote';
  try {
    proceeds = await quoteSellUsd(ctx, pos.mint, qty);
  } catch (e) {
    // No route right now: fall back to the pool's own balances, if we have them.
    let r = reserves;
    if (!r) {
      try {
        const info = await store.get(poolKeyName(pos.mint));
        const [p, b, q] = await ctx.rpc.multipleAccounts([info.pool, info.baseVault, info.quoteVault], 'confirmed');
        r = reservesOf(p, b, q);
      } catch {}
    }
    if (!solUsd) {
      try {
        solUsd = (await ctx.jup.prices([SOL]))[SOL]?.usdPrice;
      } catch {}
    }
    if (!r || !solUsd) {
      await store.log('error', `SELL ${pos.symbol} failed (${reason}): no quote or pool price`);
      return { ok: false, error: 'no price' };
    }
    proceeds = poolValueUsd(r, qty, cfg, solUsd);
    how = 'pool price';
  }
  const pnl = proceeds - pos.cost_usd;
  const price = proceeds / (Number(qty) / 10 ** TOKEN_DECIMALS);
  await adjustPaperCash(ctx, proceeds);
  await store.closePosition(mode, pos.mint);
  await store.addTrade({ mode, side: 'sell', mint: pos.mint, symbol: pos.symbol, usd: proceeds, qty_raw: pos.qty_raw, price, pnl_usd: pnl, reason: `grad: ${reason}`, sig: null });
  await store.set(poolKeyName(pos.mint), null);
  await store.setCooldown(mode, pos.mint, Date.now() + 24 * 3600e3);
  const feats = await store.get(featKeyName(pos.mint));
  if (feats) {
    await saveLesson(store, feats, pnl / pos.cost_usd, 'real');
    await store.set(featKeyName(pos.mint), null);
  }
  const held = Math.round((Date.now() - pos.opened_at) / 1000);
  await store.log('info', `SELL ${pos.symbol} (graduated) ${fmt(proceeds)} (${reason}, held ${held}s, ${how}) P&L ${pnl >= 0 ? '+' : ''}${fmt(pnl)} (${((pnl / pos.cost_usd) * 100).toFixed(0)}%)`);
  return { ok: true, pnl };
}

export const isGradPosition = async (store, mint) => !!(await store.get(poolKeyName(mint)));

// ---- engine ------------------------------------------------------------------------------

export class GradEngine {
  constructor(env) {
    this.env = env;
    this.coins = new Map(); // mint -> graduated coin being watched
    this.held = new Map(); // mint -> { pool, baseVault, quoteVault, peakValue, lastQuote, lastUpAt }
    this.shadows = new Map();
    this.seen = 0;
    this.found = 0;
    this.lastGradAt = 0;
    this.model = null;
    this.modelAt = 0;
    this.board = null;
    this.lastStatusAt = 0;
  }

  /** A graduation announced by the PumpPortal feed. */
  handleMigration(m, now = Date.now(), symbol = null) {
    if (!m || !m.mint) return;
    if (this.coins.has(m.mint)) return;
    this.seen++;
    this.lastGradAt = now;
    this.coins.set(m.mint, { mint: m.mint, symbol: symbol || m.symbol || m.mint.slice(0, 6), migratedAt: now, pool: null, lookups: 0, lastLookup: 0, hist: [], peak: 0 });
  }

  async findPool(ctx, c, now) {
    c.lastLookup = now;
    c.lookups++;
    const res = await ctx.rpc.call('getProgramAccounts', [
      AMM_PROGRAM,
      { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 43, bytes: c.mint } }, { memcmp: { offset: 75, bytes: SOL } }] },
    ]);
    const pools = (res || [])
      .map((a) => ({ key: a.pubkey, p: decodePool(Uint8Array.from(atob(a.account.data[0]), (ch) => ch.charCodeAt(0))) }))
      .filter((x) => x.p && x.p.baseMint === c.mint && x.p.quoteMint === SOL);
    if (!pools.length) return false;
    let best = pools[0];
    if (pools.length > 1) {
      // Pick the pool with the most SOL in it (the canonical migration pool).
      const vaults = await ctx.rpc.multipleAccounts(pools.map((x) => x.p.quoteVault));
      let bestQ = -1n;
      pools.forEach((x, i) => {
        const q = tokenAmount(vaults[i]) ?? 0n;
        if (q > bestQ) {
          bestQ = q;
          best = x;
        }
      });
    }
    c.pool = { pool: best.key, baseVault: best.p.baseVault, quoteVault: best.p.quoteVault };
    this.found++;
    return true;
  }

  async loadModel(store, now) {
    if (!this.model || now - this.modelAt > 60e3) {
      this.model = await store.get(MODEL_KEY, null);
      this.modelAt = now;
    }
    return this.model;
  }

  addShadow(c, r, feats, solUsd, cfg, now, twin = false) {
    if (this.shadows.size >= cfg.GRAD_MAX_SHADOWS) return false;
    const usd = cfg.GRAD_TRADE_USD;
    const tokens = haircut(ammBuy(r, BigInt(Math.floor((usd / solUsd) * 1e9)), cfg.GRAD_FEE_BPS), cfg.GRAD_PAPER_SLIPPAGE_BPS);
    if (tokens <= 0n) return false;
    this.shadows.set(c.mint, { symbol: c.symbol, ...c.pool, feats, tokens, cost: usd, peakValue: usd, opened_at: now, lastQuote: r.quote, lastUpAt: now, twin, tp: {} });
    return true;
  }

  async buy(ctx, c, r, usd, pick, expected) {
    const { store, mode, cfg } = ctx;
    const amount = BigInt(Math.floor(usd * 10 ** USDC_DECIMALS));
    let q;
    try {
      q = await ctx.jup.order({ inputMint: USDC, outputMint: c.mint, amount: String(amount) });
    } catch {
      q = null;
    }
    if (!validQuote(q, USDC, c.mint, amount)) return false;
    const tokens = haircut(BigInt(q.outAmount), cfg.GRAD_PAPER_SLIPPAGE_BPS);
    if (tokens <= 0n) return false;
    const now = Date.now();
    const entry = usd / (Number(tokens) / 10 ** TOKEN_DECIMALS);
    await adjustPaperCash(ctx, -usd);
    await store.openPosition({ mode, mint: c.mint, symbol: c.symbol, decimals: TOKEN_DECIMALS, qty_raw: tokens.toString(), cost_usd: usd, entry_price: entry, opened_at: now, buy_sig: null });
    await store.set(poolKeyName(c.mint), c.pool);
    const why = `graduated ${Math.round(pick.since)}s ago, +${pick.inflow.toFixed(1)} SOL last min, pool ${pick.liq.toFixed(0)} SOL${expected != null ? `, expects ${(expected * 100).toFixed(0)}%` : ''}`;
    await store.addTrade({ mode, side: 'buy', mint: c.mint, symbol: c.symbol, usd, qty_raw: tokens.toString(), price: entry, reason: `grad: ${why}`, sig: null });
    await store.log('info', `BUY ${c.symbol} (graduated) ${fmt(usd)} (${why}) https://pump.fun/coin/${c.mint}`);
    this.held.set(c.mint, { ...c.pool, peakValue: usd, lastQuote: r.quote, lastUpAt: now });
    this.coins.delete(c.mint);
    return true;
  }

  async tick(ctx, now, { solUsd, paused, halted }) {
    const { store, cfg, mode } = ctx;
    for (const [mint, c] of this.coins) if (now - c.migratedAt > cfg.GRAD_MAX_AGE_MIN * 60e3) this.coins.delete(mint);

    // Find pools for new graduates (a few per tick; the pool can take a few seconds to appear).
    let lookups = 0;
    for (const c of this.coins.values()) {
      if (c.pool || lookups >= 3 || now - c.lastLookup < 5e3) continue;
      lookups++;
      try {
        await this.findPool(ctx, c, now);
      } catch {}
      if (!c.pool && now - c.migratedAt > 180e3) this.coins.delete(c.mint);
    }

    // Positions this strategy holds.
    const positions = await store.positions(mode);
    const byMint = new Map(positions.map((p) => [p.mint, p]));
    for (const mint of this.held.keys()) if (!byMint.has(mint)) this.held.delete(mint);
    for (const p of positions) {
      if (this.held.has(p.mint)) continue;
      const info = await store.get(poolKeyName(p.mint));
      if (info) this.held.set(p.mint, { ...info, peakValue: p.cost_usd, lastQuote: null, lastUpAt: now });
    }

    // One batched read: pool + both vaults for everything we track.
    const keysOf = (k) => ({ pool: k.pool, baseVault: k.baseVault, quoteVault: k.quoteVault });
    const tracked = [
      ...[...this.held.entries()].map(([mint, h]) => ({ kind: 'held', mint, x: h, ...keysOf(h) })),
      ...[...this.shadows.entries()].map(([mint, sh]) => ({ kind: 'shadow', mint, x: sh, ...keysOf(sh) })),
      ...[...this.coins.values()].filter((c) => c.pool).map((c) => ({ kind: 'coin', mint: c.mint, x: c, ...keysOf(c.pool) })),
    ];
    if (!tracked.length) return this.status(ctx, now);
    let accts;
    try {
      accts = await ctx.rpc.multipleAccounts(tracked.flatMap((t) => [t.pool, t.baseVault, t.quoteVault]));
    } catch {
      return this.status(ctx, now);
    }
    tracked.forEach((t, i) => (t.r = reservesOf(accts[3 * i], accts[3 * i + 1], accts[3 * i + 2])));

    // 1) Exits.
    for (const t of tracked.filter((t) => t.kind === 'held')) {
      const p = byMint.get(t.mint);
      if (!t.r || !p) continue;
      const h = t.x;
      if (h.lastQuote === null || t.r.quote > h.lastQuote) h.lastUpAt = now;
      h.lastQuote = t.r.quote;
      const value = poolValueUsd(t.r, BigInt(p.qty_raw), cfg, solUsd);
      h.peakValue = Math.max(h.peakValue, value);
      const reason = gradExit({ cost: p.cost_usd, opened_at: p.opened_at }, value, h.peakValue, h.lastUpAt, cfg, now, activeTp(cfg, p.cost_usd));
      if (reason) {
        const res = await sellGradPosition(ctx, p, reason, t.r, solUsd);
        if (res.ok) this.held.delete(t.mint);
      } else {
        const price = value / (Number(BigInt(p.qty_raw)) / 10 ** TOKEN_DECIMALS);
        if (price !== p.last_price) await store.updatePrice(mode, t.mint, price, Math.max(p.peak_price || 0, price));
      }
    }

    // 2) Shadows: score every profit target, learn.
    for (const t of tracked.filter((t) => t.kind === 'shadow')) {
      const sh = t.x;
      if (!t.r) {
        if (now - sh.opened_at > cfg.GRAD_MAX_HOLD_MIN * 60e3 * 2) this.shadows.delete(t.mint);
        continue;
      }
      if (t.r.quote > sh.lastQuote) sh.lastUpAt = now;
      sh.lastQuote = t.r.quote;
      const value = poolValueUsd(t.r, sh.tokens, cfg, solUsd);
      sh.peakValue = Math.max(sh.peakValue, value);
      const ret = value / sh.cost - 1;
      const active = activeTp(cfg, sh.cost);
      const levels = active !== null && !TP_LEVELS.includes(active) ? [...TP_LEVELS, active] : TP_LEVELS;
      for (const l of levels) if (sh.tp[tpKey(l)] === undefined && ret >= l) sh.tp[tpKey(l)] = ret;
      if (gradExit(sh, value, sh.peakValue, sh.lastUpAt, cfg, now)) {
        const results = { none: ret };
        for (const l of levels) results[tpKey(l)] = sh.tp[tpKey(l)] ?? ret;
        this.board = await saveBoard(store, results);
        if (!sh.twin) {
          this.model = await saveLesson(store, sh.feats, results[tpKey(active)] ?? ret, 'shadow');
          this.modelAt = now;
        }
        this.shadows.delete(t.mint);
      }
    }

    // 3) Watch graduates and buy.
    const picks = [];
    for (const t of tracked.filter((t) => t.kind === 'coin')) {
      const c = t.x;
      if (!t.r) continue;
      const price = poolPriceSol(t.r);
      c.hist.push({ t: now, price, liq: Number(t.r.quote) / 1e9 });
      while (c.hist.length && now - c.hist[0].t > 90e3) c.hist.shift();
      c.peak = Math.max(c.peak, price);
      const e = gradEntry(c, t.r, cfg, now);
      if (e === 'dead') this.coins.delete(c.mint);
      else if (e) picks.push({ c, r: t.r, ...e });
    }
    picks.sort((a, b) => b.score - a.score);
    const model = await this.loadModel(store, now);
    const trained = (model?.n || 0) >= cfg.LEARN_MIN_LESSONS;
    let slots = cfg.GRAD_MAX_POSITIONS - this.held.size;
    let cash = await store.get('paper_cash', cfg.PAPER_START_USD);
    for (const pick of picks) {
      const c = pick.c;
      if (this.shadows.has(c.mint)) continue;
      if (await store.cooldownActive(mode, c.mint, now)) {
        this.coins.delete(c.mint);
        continue;
      }
      const feats = { since: pick.since, inflow: pick.inflow, liq: pick.liq, rise: pick.rise, dip: pick.dip, hour: new Date(now).getUTCHours() };
      const pred = predict(model, feats, GRAD_FEATURES);
      const learnedSkip = trained && pred.expected !== null && pred.expected * 100 < cfg.LEARN_MIN_EDGE_PCT;
      const usd = Math.min(cfg.GRAD_TRADE_USD, cash - cfg.CASH_RESERVE_USD);
      if (!paused && !halted && slots > 0 && usd >= cfg.MIN_TRADE_USD && !learnedSkip) {
        if (await this.buy(ctx, c, pick.r, usd, pick, trained ? pred.expected : null)) {
          await store.set(featKeyName(c.mint), feats);
          this.addShadow(c, pick.r, feats, solUsd, cfg, now, true);
          slots--;
          cash -= usd;
          continue;
        }
      }
      if (learnedSkip) {
        const worst = pred.reasons.filter((x) => x.effect < 0).slice(0, 2).map((x) => x.label).join(', ');
        await store.log('info', `Skip ${c.symbol} (graduated): learned this kind of setup loses (expected ${(pred.expected * 100).toFixed(0)}% from ${model.n} lessons${worst ? `; worst: ${worst}` : ''})`);
      }
      this.addShadow(c, pick.r, feats, solUsd, cfg, now);
      this.coins.delete(c.mint);
    }
    return this.status(ctx, now);
  }

  async status(ctx, now) {
    if (now - this.lastStatusAt < 10e3) return;
    this.lastStatusAt = now;
    const { store, cfg } = ctx;
    const model = await this.loadModel(store, now);
    this.board ??= await store.get(BOARD_KEY, null);
    await store.set('grad_status', {
      seen: this.seen, found: this.found, watching: this.coins.size, shadows: this.shadows.size, lastGradAt: this.lastGradAt, at: now,
      learn: summarize(model, 5, GRAD_FEATURES), learnMin: cfg.LEARN_MIN_LESSONS,
      board: boardRows(this.board, cfg.GRAD_TRADE_USD, activeTp(cfg, cfg.GRAD_TRADE_USD)),
    });
  }
}

