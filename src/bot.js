// One trading cycle: value and manage open positions, then (every few minutes)
// scan Jupiter's trending tokens for new entries.

import { Jupiter, USDC, USDC_DECIMALS } from './jupiter.js';
import { Rpc } from './rpc.js';
import { Store } from './store.js';
import { loadKeypair, signTransaction } from './solana.js';
import { loadConfig, safetyReject, entryScore, exitDecision, positionSize } from './strategy.js';
import { adaptiveScore, learnOutcome } from './adaptive.js';

const toUnits = (raw, decimals) => Number(BigInt(raw)) / 10 ** decimals;
const fmt = (n) => `$${Number(n).toFixed(2)}`;
const dayKey = (mode, now) => `day_start_${mode}_${new Date(now).toISOString().slice(0, 10)}`;

export async function makeContext(env) {
  const cfg = loadConfig(env);
  const ctx = { env, cfg, mode: cfg.MODE, jup: new Jupiter(env), store: new Store(env.DB), rpc: new Rpc(env), wallet: null };
  if (cfg.LIVE) ctx.wallet = await loadKeypair(env.WALLET_PRIVATE_KEY);
  return ctx;
}

/** Swap through Jupiter. Paper mode prices the trade with a real quote but sends nothing. */
async function swap(ctx, inputMint, outputMint, amountRaw) {
  const { jup, cfg } = ctx;
  if (!cfg.LIVE) {
    const o = await jup.order({ inputMint, outputMint, amount: amountRaw });
    if (!o.outAmount || o.outAmount === '0') return { ok: false, error: 'no route' };
    const out = (BigInt(o.outAmount) * BigInt(10000 - cfg.PAPER_SLIPPAGE_BPS)) / 10000n;
    return { ok: true, inRaw: String(amountRaw), outRaw: out.toString(), sig: null };
  }
  const o = await jup.order({ inputMint, outputMint, amount: amountRaw, taker: ctx.wallet.publicKey });
  if (!o.transaction) {
    return { ok: false, error: `order not buildable (${o.router || '?'} code ${o.errorCode ?? '?'}: ${o.errorMessage || 'no transaction'})` };
  }
  const signed = await signTransaction(o.transaction, ctx.wallet);
  const r = await jup.execute(signed, o.requestId);
  if (r.status !== 'Success') {
    return { ok: false, error: `execute failed (code ${r.code}${r.error ? `: ${r.error}` : ''})`, sig: r.signature };
  }
  return { ok: true, inRaw: r.totalInputAmount, outRaw: r.totalOutputAmount, sig: r.signature };
}

async function getCash(ctx) {
  if (!ctx.cfg.LIVE) return ctx.store.get('paper_cash', ctx.cfg.PAPER_START_USD);
  const raw = await ctx.rpc.tokenBalanceRaw(ctx.wallet.publicKey, USDC);
  return toUnits(raw, USDC_DECIMALS);
}

async function adjustPaperCash(ctx, delta) {
  if (ctx.cfg.LIVE) return;
  const cash = await ctx.store.get('paper_cash', ctx.cfg.PAPER_START_USD);
  await ctx.store.set('paper_cash', Math.round((cash + delta) * 1e6) / 1e6);
}

/** Current USD price for each open position (Price API, falling back to a sell quote). */
async function priceOpenPositions(ctx, positions) {
  const prices = {};
  if (!positions.length) return prices;
  let api = {};
  try {
    api = await ctx.jup.prices(positions.map((p) => p.mint));
  } catch (e) {
    await ctx.store.log('warn', `Price API: ${e.message}`);
  }
  for (const p of positions) {
    const px = api[p.mint]?.usdPrice;
    if (px > 0) {
      prices[p.mint] = px;
      continue;
    }
    try {
      const q = await ctx.jup.order({ inputMint: p.mint, outputMint: USDC, amount: p.qty_raw });
      const value = toUnits(q.outAmount || '0', USDC_DECIMALS);
      const qty = toUnits(p.qty_raw, p.decimals);
      if (value > 0 && qty > 0) prices[p.mint] = value / qty;
    } catch (e) {
      await ctx.store.log('warn', `No price for ${p.symbol}: ${e.message}`);
    }
  }
  return prices;
}

export async function sellPosition(ctx, pos, reason) {
  const { store, mode } = ctx;
  let qty = BigInt(pos.qty_raw);
  if (ctx.cfg.LIVE) {
    const held = BigInt(await ctx.rpc.tokenBalanceRaw(ctx.wallet.publicKey, pos.mint));
    if (held === 0n) {
      await store.closePosition(mode, pos.mint);
      await store.log('warn', `${pos.symbol}: wallet holds none, removed position (sold elsewhere?)`);
      return { ok: false, error: 'nothing held' };
    }
    if (held < qty) qty = held;
  }
  let r;
  try {
    r = await swap(ctx, pos.mint, USDC, qty.toString());
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  if (!r.ok) {
    await store.log('error', `SELL ${pos.symbol} failed (${reason}): ${r.error}`);
    return r;
  }
  const proceeds = toUnits(r.outRaw, USDC_DECIMALS);
  const pnl = proceeds - pos.cost_usd;
  const price = proceeds / toUnits(qty.toString(), pos.decimals);
  await adjustPaperCash(ctx, proceeds);
  await store.closePosition(mode, pos.mint);
  await store.addTrade({ mode, side: 'sell', mint: pos.mint, symbol: pos.symbol, usd: proceeds, qty_raw: qty.toString(), price, pnl_usd: pnl, reason, sig: r.sig });
  if (!ctx.cfg.LIVE) {
    const key = `v2_strategy_${pos.mint}`;
    const strategy = await store.get(key);
    if (strategy) {
      const model = await store.get('v2_learning_paper', {});
      await store.set('v2_learning_paper', learnOutcome(model, strategy, pnl));
      await store.set(key, null);
    }
  }
  await store.setCooldown(mode, pos.mint, Date.now() + ctx.cfg.COOLDOWN_HOURS * 3600e3);
  await store.log('info', `SELL ${pos.symbol} ${fmt(proceeds)} (${reason}) P&L ${pnl >= 0 ? '+' : ''}${fmt(pnl)}`);
  return { ok: true, pnl };
}

async function buyToken(ctx, token, usd, score, strategy = 'momentum') {
  const { store, mode } = ctx;
  const amountRaw = BigInt(Math.floor(usd * 10 ** USDC_DECIMALS)).toString();
  let r;
  try {
    r = await swap(ctx, USDC, token.id, amountRaw);
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  if (!r.ok || BigInt(r.outRaw || '0') === 0n) {
    await store.log('error', `BUY ${token.symbol} failed: ${r.error || 'zero output'}`);
    return false;
  }
  const cost = toUnits(r.inRaw, USDC_DECIMALS);
  const qty = toUnits(r.outRaw, token.decimals);
  const entry = cost / qty;
  await adjustPaperCash(ctx, -cost);
  await store.openPosition({ mode, mint: token.id, symbol: token.symbol, decimals: token.decimals, qty_raw: r.outRaw, cost_usd: cost, entry_price: entry, opened_at: Date.now(), buy_sig: r.sig });
  if (!ctx.cfg.LIVE) await store.set(`v2_strategy_${token.id}`, strategy);
  await store.addTrade({ mode, side: 'buy', mint: token.id, symbol: token.symbol, usd: cost, qty_raw: r.outRaw, price: entry, reason: `${strategy} score ${score.toFixed(1)}`, sig: r.sig });
  await store.log('info', `BUY ${token.symbol} ${fmt(cost)} @ ${entry.toPrecision(4)} (1h ${token.stats1h.priceChange.toFixed(1)}%, organic ${Math.round(token.organicScore || 0)})`);
  return true;
}

async function findCandidates(ctx, heldMints) {
  const lists = await Promise.allSettled([
    ctx.jup.category('toptrending', '1h', 100),
    ctx.jup.category('toptraded', '1h', 100),
  ]);
  const seen = new Map();
  for (const l of lists) {
    if (l.status === 'rejected') {
      await ctx.store.log('warn', `Token scan: ${l.reason?.message || l.reason}`);
      continue;
    }
    for (const t of l.value || []) if (t?.id && !seen.has(t.id)) seen.set(t.id, t);
  }
  const out = [];
  const model = await ctx.store.get('v2_learning_paper', {});
  const now = Date.now();
  for (const t of seen.values()) {
    if (heldMints.has(t.id)) continue;
    if (safetyReject(t, ctx.cfg, now)) continue;
    const score = entryScore(t, ctx.cfg);
    const adaptive = !ctx.cfg.LIVE ? adaptiveScore(t, score, model) : null;
    if (!ctx.cfg.LIVE && !adaptive) continue;
    if (score === null) continue;
    if (await ctx.store.cooldownActive(ctx.mode, t.id, now)) continue;
    out.push({ token: t, score: adaptive?.score ?? score, strategy: adaptive?.strategy ?? 'momentum' });
  }
  out.sort((a, b) => b.score - a.score);
  return { scanned: seen.size, picks: out };
}

/** Run one cycle. Returns a short summary object. */
export async function runCycle(env, { forceScan = false, manageOnly = false } = {}) {
  const ctx = await makeContext(env);
  const { store, cfg, mode } = ctx;
  const now = Date.now();

  if (!(await store.acquireCycleLock(now))) return { skipped: 'another cycle is running' };

  try {
    // 1) Manage open positions.
    let positions = await store.positions(mode);
    const prices = await priceOpenPositions(ctx, positions);
    for (const pos of positions) {
      const price = prices[pos.mint];
      if (!price) continue;
      const strategy = !cfg.LIVE ? await store.get(`v2_strategy_${pos.mint}`, 'momentum') : 'momentum';
      const d = exitDecision(pos, price, cfg, now, strategy);
      await store.updatePrice(mode, pos.mint, price, d.peak);
      if (d.sell) await sellPosition(ctx, pos, d.reason);
    }

    // 2) Equity and daily loss guard.
    positions = await store.positions(mode);
    const cash = await getCash(ctx);
    const held = positions.reduce((s, p) => s + toUnits(p.qty_raw, p.decimals) * (prices[p.mint] || p.last_price || p.entry_price), 0);
    const equity = cash + held;
    await store.recordEquity(mode, equity);

    const dk = dayKey(mode, now);
    let dayStart = await store.get(dk);
    if (dayStart === null) {
      dayStart = equity;
      await store.set(dk, equity);
    }
    const dayChange = dayStart > 0 ? equity / dayStart - 1 : 0;
    const halted = dayChange <= -cfg.DAILY_LOSS_LIMIT_PCT;
    if (halted && !(await store.get(`${dk}_halt_logged`))) {
      await store.set(`${dk}_halt_logged`, true);
      await store.log('warn', `Daily loss limit hit (${(dayChange * 100).toFixed(1)}%). No new buys until tomorrow (UTC).`);
    }

    // 3) Scan for entries.
    const paused = await store.get('paused', false);
    const lastScan = await store.get(`last_scan_${mode}`, 0);
    const scanDue = forceScan || now - lastScan >= cfg.SCAN_EVERY_MIN * 60e3 - 15e3;
    let bought = 0;
    let scanned = 0;
    if (!manageOnly && !paused && !halted && scanDue && positions.length < cfg.MAX_POSITIONS) {
      await store.set(`last_scan_${mode}`, now);
      if (cfg.LIVE) {
        const sol = await ctx.rpc.solBalance(ctx.wallet.publicKey);
        if (sol < 0.005) await store.log('warn', `Low SOL for fees (${sol.toFixed(4)} SOL). Buys may fail unless Jupiter sponsors gas.`);
      }
      const { scanned: n, picks } = await findCandidates(ctx, new Set(positions.map((p) => p.mint)));
      scanned = n;
      let slots = cfg.MAX_POSITIONS - positions.length;
      let availableCash = cash;
      for (const { token, score, strategy } of picks) {
        if (slots <= 0) break;
        const usd = positionSize(equity, availableCash, cfg);
        if (!usd) break;
        if (await buyToken(ctx, token, usd, score, strategy)) {
          slots--;
          bought++;
          availableCash -= usd;
        }
      }
      if (!picks.length) await store.set('last_scan_note', `${new Date(now).toISOString()}: scanned ${n} tokens, none passed filters`);
    }

    return { mode, equity, cash, positions: positions.length, bought, scanned, paused, halted };
  } catch (e) {
    await store.log('error', `Cycle error: ${e.message}`);
    throw e;
  } finally {
    await store.releaseCycleLock(now);
  }
}
