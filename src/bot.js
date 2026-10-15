// One trading cycle: value and manage open positions (every tick, every few seconds), then
// (every SCAN_EVERY_SEC) scan Jupiter's trending tokens for new entries.

import { Jupiter, USDC, USDC_DECIMALS } from './jupiter.js';
import { Rpc } from './rpc.js';
import { Store } from './store.js';
import { loadKeypair, signTransaction } from './solana.js';
import { loadConfig, safetyReject, entryScore, exitDecision, positionSize, costReject } from './strategy.js';
import { adaptiveFactor, learnOutcome } from './adaptive.js';

const toUnits = (raw, decimals) => Number(BigInt(raw)) / 10 ** decimals;
const fmt = (n) => `$${Number(n).toFixed(2)}`;
const dayKey = (mode, now) => `day_start_${mode}_${new Date(now).toISOString().slice(0, 10)}`;
const learnKey = (mode) => `v2_learning_${mode}`;
const stratKey = (mode, mint) => (mode === 'paper' ? `v2_strategy_${mint}` : `v2_strategy_live_${mint}`);
const LOCK_STALE_MS = 60e3;

export async function makeContext(env) {
  const cfg = loadConfig(env);
  const ctx = { env, cfg, mode: cfg.MODE, jup: new Jupiter(env), store: new Store(env.DB), rpc: new Rpc(env), wallet: null };
  if (cfg.LIVE) ctx.wallet = await loadKeypair(env.WALLET_PRIVATE_KEY);
  return ctx;
}

/** Get a Jupiter order (quote, plus an unsigned transaction in live mode). */
function getOrder(ctx, inputMint, outputMint, amountRaw) {
  const taker = ctx.cfg.LIVE ? ctx.wallet.publicKey : undefined;
  return ctx.jup.order({ inputMint, outputMint, amount: amountRaw, taker });
}

/** Fill an order. Paper mode uses the real quote with a haircut and sends nothing. */
async function fillOrder(ctx, o, amountRaw) {
  const { jup, cfg } = ctx;
  if (!o.outAmount || o.outAmount === '0') return { ok: false, error: 'no route' };
  if (!cfg.LIVE) {
    const out = (BigInt(o.outAmount) * BigInt(10000 - cfg.PAPER_SLIPPAGE_BPS)) / 10000n;
    return { ok: true, inRaw: String(amountRaw), outRaw: out.toString(), sig: null };
  }
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

async function swap(ctx, inputMint, outputMint, amountRaw) {
  return fillOrder(ctx, await getOrder(ctx, inputMint, outputMint, amountRaw), amountRaw);
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

/** Current USD price for each open position (one batched Price API call, falling back to a sell quote). */
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
  const sk = stratKey(mode, pos.mint);
  const strategy = await store.get(sk);
  if (strategy) {
    const model = await store.get(learnKey(mode), {});
    await store.set(learnKey(mode), learnOutcome(model, strategy, pnl));
    await store.set(sk, null);
  }
  await store.setCooldown(mode, pos.mint, Date.now() + ctx.cfg.COOLDOWN_HOURS * 3600e3);
  const held = Math.round((Date.now() - pos.opened_at) / 60e3);
  await store.log('info', `SELL ${pos.symbol} ${fmt(proceeds)} (${reason}, held ${held}m) P&L ${pnl >= 0 ? '+' : ''}${fmt(pnl)}`);
  return { ok: true, pnl };
}

/** Buy only if buying and immediately selling back would cost less than the configured limit. */
async function buyToken(ctx, token, usd, score) {
  const { store, mode, cfg, jup } = ctx;
  const amountRaw = BigInt(Math.floor(usd * 10 ** USDC_DECIMALS)).toString();
  let r;
  try {
    const o = await getOrder(ctx, USDC, token.id, amountRaw);
    if (!o.outAmount || o.outAmount === '0') {
      r = { ok: false, error: 'no route' };
    } else {
      const back = await jup.order({ inputMint: token.id, outputMint: USDC, amount: o.outAmount });
      const reject = costReject(usd, toUnits(back.outAmount || '0', USDC_DECIMALS), cfg);
      if (reject) {
        await store.setCooldown(mode, token.id, Date.now() + 10 * 60e3);
        await store.log('info', `Skip ${token.symbol}: ${reject}`);
        return false;
      }
      r = await fillOrder(ctx, o, amountRaw);
    }
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
  await store.set(stratKey(mode, token.id), cfg.STRATEGY);
  await store.addTrade({ mode, side: 'buy', mint: token.id, symbol: token.symbol, usd: cost, qty_raw: r.outRaw, price: entry, reason: `${cfg.STRATEGY} score ${score.toFixed(1)}`, sig: r.sig });
  const m5 = token.stats5m?.priceChange ?? 0;
  const h1 = token.stats1h?.priceChange ?? 0;
  await store.log('info', `BUY ${token.symbol} ${fmt(cost)} @ ${entry.toPrecision(4)} (5m ${m5.toFixed(1)}%, 1h ${h1.toFixed(1)}%, organic ${Math.round(token.organicScore || 0)})`);
  return true;
}

async function findCandidates(ctx, heldMints) {
  const iv = ctx.cfg.SCAN_INTERVAL_NAME;
  const lists = await Promise.allSettled([
    ctx.jup.category('toptrending', iv, 100),
    ctx.jup.category('toptraded', iv, 100),
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
  // Same rules in paper and live, so paper results predict live results.
  const factor = adaptiveFactor(await ctx.store.get(learnKey(ctx.mode), {}), ctx.cfg.STRATEGY);
  const now = Date.now();
  for (const t of seen.values()) {
    if (heldMints.has(t.id)) continue;
    if (safetyReject(t, ctx.cfg, now)) continue;
    const score = entryScore(t, ctx.cfg);
    if (score === null) continue;
    if (await ctx.store.cooldownActive(ctx.mode, t.id, now)) continue;
    out.push({ token: t, score: score * factor });
  }
  out.sort((a, b) => b.score - a.score);
  return { scanned: seen.size, picks: out };
}

/** True while a losing streak should keep the bot from opening new trades. */
async function lossStreakActive(ctx, now) {
  const n = ctx.cfg.LOSS_STREAK_LIMIT;
  if (!(n > 0)) return false;
  const recent = await ctx.store.recentSells(ctx.mode, n);
  if (recent.length < n || recent.some((t) => (t.pnl_usd || 0) > 0)) return false;
  const until = recent[0].ts + ctx.cfg.LOSS_STREAK_PAUSE_MIN * 60e3;
  if (now >= until) return false;
  const key = `streak_logged_${ctx.mode}_${recent[0].ts}`;
  if (!(await ctx.store.get(key))) {
    await ctx.store.set(key, true);
    await ctx.store.log('warn', `${n} losing trades in a row. No new buys for ${ctx.cfg.LOSS_STREAK_PAUSE_MIN} minutes.`);
  }
  return true;
}

/** Run one cycle. Returns a short summary object. */
export async function runCycle(env, { forceScan = false } = {}) {
  const ctx = await makeContext(env);
  const { store, cfg, mode } = ctx;
  const now = Date.now();

  const lock = await store.get('lock', 0);
  if (now - lock < LOCK_STALE_MS) return { skipped: 'another cycle is running' };
  await store.set('lock', now);

  try {
    // 1) Manage open positions.
    let positions = await store.positions(mode);
    const prices = await priceOpenPositions(ctx, positions);
    for (const pos of positions) {
      const price = prices[pos.mint];
      if (!price) continue;
      const d = exitDecision(pos, price, cfg, now);
      if (d.sell) await sellPosition(ctx, pos, d.reason);
      else if (price !== pos.last_price || d.peak !== pos.peak_price) await store.updatePrice(mode, pos.mint, price, d.peak);
    }

    // 2) Equity and daily loss guard.
    positions = await store.positions(mode);
    const cash = await getCash(ctx);
    const held = positions.reduce((s, p) => s + toUnits(p.qty_raw, p.decimals) * (prices[p.mint] || p.last_price || p.entry_price), 0);
    const equity = cash + held;
    const eqKey = `last_equity_ts_${mode}`;
    if (now - (await store.get(eqKey, 0)) >= 60e3) {
      await store.recordEquity(mode, equity);
      await store.set(eqKey, now);
    }

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
    const scanDue = forceScan || now - lastScan >= cfg.SCAN_EVERY_SEC * 1000 - 2e3;
    let bought = 0;
    let scanned = 0;
    let cooling = false;
    if (!paused && !halted && scanDue && positions.length < cfg.MAX_POSITIONS) {
      await store.set(`last_scan_${mode}`, now);
      cooling = await lossStreakActive(ctx, now);
    }
    if (!paused && !halted && !cooling && scanDue && positions.length < cfg.MAX_POSITIONS) {
      if (cfg.LIVE) {
        const sol = await ctx.rpc.solBalance(ctx.wallet.publicKey);
        if (sol < 0.005) await store.log('warn', `Low SOL for fees (${sol.toFixed(4)} SOL). Buys may fail unless Jupiter sponsors gas.`);
      }
      const { scanned: n, picks } = await findCandidates(ctx, new Set(positions.map((p) => p.mint)));
      scanned = n;
      let slots = cfg.MAX_POSITIONS - positions.length;
      let availableCash = cash;
      for (const { token, score } of picks.slice(0, slots + 2)) {
        if (slots <= 0) break;
        const usd = positionSize(equity, availableCash, cfg);
        if (!usd) break;
        if (await buyToken(ctx, token, usd, score)) {
          slots--;
          bought++;
          availableCash -= usd;
        }
      }
      if (!picks.length) await store.set('last_scan_note', `${new Date(now).toISOString()}: scanned ${n} tokens, none passed filters`);
    }

    return { mode, equity, cash, positions: positions.length, bought, scanned, paused, halted, cooling };
  } catch (e) {
    await store.log('error', `Cycle error: ${e.message}`);
    throw e;
  } finally {
    await store.set('lock', 0);
  }
}
