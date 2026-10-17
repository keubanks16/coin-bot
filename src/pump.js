// Pump.fun sniper (STRATEGY = "pump").
//
// 1. Listens to PumpPortal's free live feed of every new pump.fun coin (one WebSocket).
// 2. Every PUMP_POLL_SECONDS, reads the bonding curve of every young coin straight from Solana
//    (one batched RPC call) to see how much SOL other traders are putting in.
// 3. Buys a coin that is still cheap, has real buying behind it, is climbing right now, has
//    social links, and whose creator hasn't dumped.
// 4. Rides it and sells on the first real downturn (a drop from its peak), a stall, the stop loss,
//    or the max hold time.
//
// Paper mode only for now: prices come from the real on-chain bonding curve with pump.fun's
// fees and an extra per-side haircut for being slower than dedicated sniper bots.

import { SOL, USDC, USDC_DECIMALS } from './jupiter.js';
import { featuresOf, learn, predict, summarize } from './learn.js';

const CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];
const TOKEN_DECIMALS = 6;
const FEED_URL = 'https://pumpportal.fun/api/data';
const fmt = (n) => `$${Number(n).toFixed(2)}`;
const curveKeyName = (mint) => `pump_curve_${mint}`;
const migrationKeyName = (mint) => `pump_migrated_${mint}`;
const featKeyName = (mint) => `pump_feat_${mint}`;
// v2: lessons are measured under the take-profit exit rules, so the v1 lessons (no take
// profit) are kept under 'pump_model' but no longer used.
const MODEL_KEY = 'pump_model_v2';
const BOARD_KEY = 'pump_tp_board';
/** Take-profit targets (as a fraction of the buy) that every followed coin is scored against. */
export const TP_LEVELS = [0.1, 0.15, 0.25, 0.4, 0.6];
const tpKey = (l) => (l === null ? 'none' : String(Math.round(l * 100)));
const dayKey = (mode, now) => `day_start_${mode}_${new Date(now).toISOString().slice(0, 10)}`;

// ---- bonding curve ------------------------------------------------------------------------

/** Decode a pump.fun BondingCurve account. Returns null if it isn't one. */
export function decodeCurve(bytes) {
  if (!bytes || bytes.length < 49) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== CURVE_DISCRIMINATOR[i]) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (o) => dv.getBigUint64(o, true);
  // quote_mint (offset 83) is all zeros for SOL-paired coins; older accounts don't have it.
  let quoteIsSol = true;
  if (bytes.length >= 115) for (let i = 83; i < 115; i++) if (bytes[i] !== 0) quoteIsSol = false;
  return {
    vTok: u64(8),
    vSol: u64(16),
    realTok: u64(24),
    realSol: u64(32),
    supply: u64(40),
    complete: bytes[48] === 1,
    quoteIsSol,
  };
}

/** Tokens received (raw) for `lamports` spent, after the fee. */
export function curveBuy(c, lamports, feeBps) {
  const net = (BigInt(lamports) * 10000n) / (10000n + BigInt(feeBps));
  if (net <= 0n) return 0n;
  const k = c.vSol * c.vTok;
  const out = c.vTok - (k + c.vSol + net - 1n) / (c.vSol + net);
  return out > c.realTok ? c.realTok : out;
}

/** Lamports received for selling `tokens` (raw), after the fee. */
export function curveSell(c, tokens, feeBps) {
  const t = BigInt(tokens);
  if (t <= 0n) return 0n;
  const k = c.vSol * c.vTok;
  const gross = c.vSol - (k + c.vTok + t - 1n) / (c.vTok + t);
  return (gross * (10000n - BigInt(feeBps))) / 10000n;
}

export const curvePriceSol = (c) => Number(c.vSol) / 1e9 / (Number(c.vTok) / 10 ** TOKEN_DECIMALS);
export const curveMcapSol = (c) => (Number(c.vSol) * Number(c.supply)) / Number(c.vTok) / 1e9;
const haircut = (x, bps) => (BigInt(x) * BigInt(10000 - bps)) / 10000n;

// ---- rules --------------------------------------------------------------------------------

/**
 * Should we buy this watched coin now? Returns { score } to buy, 'dead' to stop watching,
 * or null to keep watching. `c.hist` holds recent samples, newest last.
 */
export function pumpEntry(c, s, cfg, now) {
  const age = (now - c.created) / 1000;
  if (s.complete || !s.quoteIsSol) return 'dead';
  if (age > cfg.PUMP_MAX_AGE_SEC) return 'dead';
  const inflow = Number(s.vSol) / 1e9 - c.startVSol;
  if (age > 60 && inflow < 0.5) return 'dead'; // nobody's interested
  if (age < cfg.PUMP_MIN_AGE_SEC) return null;
  if (inflow < cfg.PUMP_MIN_INFLOW_SOL) return null;
  if (curveMcapSol(s) > cfg.PUMP_MAX_MCAP_SOL) return null;
  const price = curvePriceSol(s);
  const prev = c.hist[c.hist.length - 3];
  if (!prev) return null;
  if ((price / prev.price - 1) * 100 < cfg.PUMP_MIN_TICK_RISE_PCT) return null; // climbing right now
  if (price < c.peak * (1 - cfg.PUMP_DOWNTURN_PCT)) return null; // already turning down
  return { score: (inflow / Math.max(age, 10)) * 60, inflow, mcap: curveMcapSol(s), age, rise: (price / prev.price - 1) * 100 };
}

/** Should we sell this position? `price` and `peak` are per-token USD you'd really get. */
export function pumpExit(pos, price, peak, s, lastUpAt, cfg, now, takeProfitPct = null) {
  const pnl = price / pos.entry_price - 1;
  const peakGain = peak / pos.entry_price - 1;
  if (s.complete) return 'graduated';
  if (takeProfitPct !== null && pnl >= takeProfitPct) return 'take profit';
  if (pnl <= -cfg.PUMP_STOP_LOSS_PCT) return 'stop loss';
  if (peakGain >= cfg.PUMP_TRAIL_ARM_PCT && price <= peak * (1 - cfg.PUMP_DOWNTURN_PCT)) return 'first downturn';
  if (now - lastUpAt >= cfg.PUMP_STALL_SEC * 1000) return 'stalled';
  if (now - pos.opened_at >= cfg.PUMP_MAX_HOLD_MIN * 60e3) return 'max hold time';
  return null;
}

/** Market value in USD of selling `tokens` into curve `s` right now (fees + paper haircut). */
function sellValueUsd(s, tokens, cfg, solUsd) {
  const lamports = haircut(curveSell(s, tokens, cfg.PUMP_FEE_BPS), cfg.PUMP_PAPER_SLIPPAGE_BPS);
  return (Number(lamports) / 1e9) * solUsd;
}

async function solPrice(ctx, cache) {
  if (cache.solUsd && Date.now() - cache.at < 60e3) return cache.solUsd;
  try {
    const p = (await ctx.jup.prices([SOL]))[SOL]?.usdPrice;
    if (p > 0) Object.assign(cache, { solUsd: p, at: Date.now() });
  } catch (e) {
    // keep the last known price
  }
  return cache.solUsd;
}
const solCache = { solUsd: null, at: 0 };

async function adjustPaperCash(ctx, delta) {
  const cash = await ctx.store.get('paper_cash', ctx.cfg.PAPER_START_USD);
  await ctx.store.set('paper_cash', Math.round((cash + delta) * 1e6) / 1e6);
}

/** Quote the entire simulated holding after migration. Never use the completed curve. */
async function migratedValueUsd(ctx, mint, qtyRaw) {
  const q = await ctx.jup.order({ inputMint: mint, outputMint: USDC, amount: String(qtyRaw) });
  if (!q || q.error || q.errorCode != null || q.inputMint !== mint || q.outputMint !== USDC ||
      !/^\d+$/.test(String(q.inAmount)) || BigInt(q.inAmount) !== BigInt(qtyRaw) ||
      !/^\d+$/.test(String(q.outAmount)) || BigInt(q.outAmount) <= 0n) {
    throw new Error('no valid full-size post-migration sell quote');
  }
  // The quote already includes swap fees/impact; apply only the paper execution haircut.
  return Number(haircut(BigInt(q.outAmount), ctx.cfg.PUMP_PAPER_SLIPPAGE_BPS)) / 10 ** USDC_DECIMALS;
}

/** Sell a pump position at the current curve price (also used by the dashboard's Sell buttons). */
export async function sellPumpPosition(ctx, pos, reason, sample = null) {
  const { store, mode, cfg } = ctx;
  if (cfg.LIVE) return { ok: false, error: 'pump exits are paper-only' };
  if (!(await store.position(mode, pos.mint))) return { ok: false, error: 'already sold' };
  let migrated = await store.get(migrationKeyName(pos.mint), false);
  let s = sample;
  if (!s && !migrated) {
    const curve = await store.get(curveKeyName(pos.mint));
    try {
      s = decodeCurve((await ctx.rpc.multipleAccounts([curve], 'confirmed'))[0]);
    } catch (e) {
      await store.log('error', `SELL ${pos.symbol} failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }
  if (s?.complete && !migrated) {
    migrated = true;
    await store.set(migrationKeyName(pos.mint), true);
  }
  const solUsd = migrated ? null : await solPrice(ctx, solCache);
  if (!migrated && (!s || !solUsd)) {
    await store.log('error', `SELL ${pos.symbol} failed (${reason}): no curve or SOL price`);
    return { ok: false, error: 'no price' };
  }
  const qty = BigInt(pos.qty_raw);
  let proceeds;
  if (migrated) {
    try {
      proceeds = await migratedValueUsd(ctx, pos.mint, qty);
    } catch (e) {
      const key = `pump_migration_warn_${pos.mint}`;
      const now = Date.now();
      if (now - (await store.get(key, 0)) >= 60e3) {
        await store.set(key, now);
        await store.log('warn', `SELL ${pos.symbol}: waiting for post-migration sell route (${e.message}); position remains open`);
      }
      return { ok: false, pending: true, error: 'waiting for post-migration sell route' };
    }
  } else {
    proceeds = sellValueUsd(s, qty, cfg, solUsd);
  }
  const pnl = proceeds - pos.cost_usd;
  const price = proceeds / (Number(qty) / 10 ** TOKEN_DECIMALS);
  await adjustPaperCash(ctx, proceeds);
  await store.closePosition(mode, pos.mint);
  await store.addTrade({ mode, side: 'sell', mint: pos.mint, symbol: pos.symbol, usd: proceeds, qty_raw: pos.qty_raw, price, pnl_usd: pnl, reason, sig: null });
  await store.set(curveKeyName(pos.mint), null);
  await store.set(migrationKeyName(pos.mint), null);
  await store.setCooldown(mode, pos.mint, Date.now() + 24 * 3600e3);
  const feats = await store.get(featKeyName(pos.mint));
  if (feats) {
    await saveLesson(store, feats, pnl / pos.cost_usd, 'real');
    await store.set(featKeyName(pos.mint), null);
  }
  const held = Math.round((Date.now() - pos.opened_at) / 1000);
  await store.log('info', `SELL ${pos.symbol} ${fmt(proceeds)} (${reason}, held ${held}s) P&L ${pnl >= 0 ? '+' : ''}${fmt(pnl)} (${((pnl / pos.cost_usd) * 100).toFixed(0)}%)`);
  return { ok: true, pnl };
}

/** Record a finished lesson in the shared model (read-modify-write, so dashboard sells count too). */
/** Add one followed coin's results under every take-profit target to the scoreboard. */
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

/** Scoreboard rows for the dashboard: what each take-profit target would have returned. */
export function boardRows(board, tradeUsd, activePct) {
  if (!board) return [];
  return Object.entries(board)
    .map(([k, b]) => ({ target: k === 'none' ? null : Number(k), n: b.n, avg: b.sum / b.n, usd: (b.sum / b.n) * tradeUsd, winRate: b.wins / b.n, active: k === tpKey(activePct) }))
    .sort((a, b) => (a.target ?? 1e9) - (b.target ?? 1e9));
}

const activeTp = (cfg, cost) => (cfg.PUMP_TAKE_PROFIT_USD > 0 ? cfg.PUMP_TAKE_PROFIT_USD / cost : null);

async function saveLesson(store, feats, ret, kind) {
  const model = learn(await store.get(MODEL_KEY, null), feats, ret, kind);
  await store.set(MODEL_KEY, model);
  return model;
}

const GATEWAYS = ['https://ipfs.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/'];

/** Every URL that could serve this metadata: the original plus other IPFS gateways for the same file. */
function metadataUrls(uri) {
  if (!uri) return [];
  let cid = null;
  if (uri.startsWith('ipfs://')) cid = uri.slice(7);
  else {
    const m = uri.match(/\/ipfs\/(.+)$/);
    if (m) cid = m[1];
  }
  const urls = uri.startsWith('http') ? [uri] : [];
  if (cid) for (const g of GATEWAYS) if (!urls.includes(g + cid)) urls.push(g + cid);
  return urls;
}

/** Fetch coin metadata from whichever gateway answers first. */
async function fetchMetadata(uri, ms) {
  const urls = metadataUrls(uri);
  if (!urls.length) return null;
  return Promise.any(urls.map((u) => fetchJson(u, ms)));
}

async function fetchJson(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ---- engine -------------------------------------------------------------------------------

export class PumpEngine {
  constructor(env) {
    this.env = env;
    this.watch = new Map(); // mint -> coin we're watching
    this.held = new Map(); // mint -> { curve, lastVSol, lastUpAt }
    this.seen = 0;
    this.lastCoinAt = 0;
    this.ws = null;
    this.lastMsgAt = 0;
    this.lastConnectTry = 0;
    this.feedState = 'starting';
    this.feedDisabled = false; // tests
    this.busy = false;
    this.lastStatusAt = 0;
    this.lastWarnAt = {};
    this.shadows = new Map(); // mint -> coin followed without money, to learn from
    this.model = null;
    this.modelAt = 0;
  }

  async loadModel(ctx, now) {
    if (!this.model || now - this.modelAt > 60e3) {
      this.model = await ctx.store.get(MODEL_KEY, null);
      this.modelAt = now;
    }
    return this.model;
  }

  /** Start following a coin without money. */
  addShadow(c, s, feats, solUsd, cfg, now, twin = false) {
    if (this.shadows.size >= cfg.PUMP_MAX_SHADOWS) return false;
    const usd = cfg.PUMP_TRADE_USD;
    const tokens = haircut(curveBuy(s, BigInt(Math.floor((usd / solUsd) * 1e9)), cfg.PUMP_FEE_BPS), cfg.PUMP_PAPER_SLIPPAGE_BPS);
    if (tokens <= 0n) return false;
    const entry = usd / (Number(tokens) / 10 ** TOKEN_DECIMALS);
    this.shadows.set(c.mint, { symbol: c.symbol, curve: c.curve, feats, tokens, cost: usd, entry_price: entry, peak: entry, opened_at: now, lastVSol: s.vSol, lastUpAt: now, twin, tp: {} });
    return true;
  }

  /** A message from the PumpPortal feed. */
  handleMessage(m, now = Date.now(), cfg = null) {
    if (!m || m.txType !== 'create' || !m.mint || !m.bondingCurveKey) return;
    if (m.pool && m.pool !== 'pump') return; // other launchpads use different curves
    this.seen++;
    this.lastCoinAt = now;
    let devTokens = Number(m.initialBuy || 0);
    if (devTokens > 1e12) devTokens /= 10 ** TOKEN_DECIMALS; // raw units -> tokens
    const devPct = (devTokens / 1e9) * 100;
    const maxDev = cfg?.PUMP_MAX_DEV_PCT ?? 10;
    if (devPct > maxDev) return;
    this.watch.set(m.mint, {
      mint: m.mint,
      symbol: String(m.symbol || '?').slice(0, 16),
      name: String(m.name || '').slice(0, 40),
      uri: m.uri || '',
      dev: m.traderPublicKey || null,
      devTokensRaw: BigInt(Math.floor(devTokens * 10 ** TOKEN_DECIMALS)),
      devPct,
      curve: m.bondingCurveKey,
      created: now,
      startVSol: Number(m.vSolInBondingCurve) > 0 ? Number(m.vSolInBondingCurve) : 30 + Number(m.solAmount || 0),
      hist: [],
      peak: 0,
      vetted: null,
    });
  }

  async warn(ctx, key, msg, everyMs = 60e3) {
    const now = Date.now();
    if (now - (this.lastWarnAt[key] || 0) < everyMs) return;
    this.lastWarnAt[key] = now;
    await ctx.store.log('warn', msg);
  }

  async ensureFeed(ctx, now) {
    if (this.feedDisabled) return;
    if (this.ws && now - this.lastMsgAt < 60e3) return;
    if (now - this.lastConnectTry < 10e3) return;
    this.lastConnectTry = now;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    try {
      const key = this.env.PUMPPORTAL_API_KEY;
      const res = await fetch(FEED_URL + (key ? `?api-key=${encodeURIComponent(key)}` : ''), { headers: { Upgrade: 'websocket' } });
      const ws = res.webSocket;
      if (!ws) throw new Error(`feed refused the connection (HTTP ${res.status})`);
      ws.accept();
      ws.addEventListener('message', (ev) => {
        this.lastMsgAt = Date.now();
        try {
          this.handleMessage(JSON.parse(ev.data), Date.now(), ctx.cfg);
        } catch {}
      });
      const drop = () => {
        if (this.ws === ws) {
          this.ws = null;
          this.feedState = 'reconnecting';
        }
      };
      ws.addEventListener('close', drop);
      ws.addEventListener('error', drop);
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      this.ws = ws;
      this.lastMsgAt = now;
      this.feedState = 'connected';
    } catch (e) {
      this.feedState = `error: ${e.message}`;
      await this.warn(ctx, 'feed', `Pump.fun feed: ${e.message}`);
    }
  }

  /** Is this coin worth the risk? Checked once per coin, right before buying. Returns a reason to skip, or null. */
  async vet(ctx, c) {
    if (c.vetted !== null) return c.vetted;
    let reason = null;
    if (ctx.cfg.PUMP_REQUIRE_SOCIALS) {
      const url = metadataUrls(c.uri).length > 0;
      try {
        const meta = url ? await fetchMetadata(c.uri, 3000) : null;
        c.socials = meta ? ['twitter', 'telegram', 'website'].filter((k) => meta[k]).length : 0;
        if (!c.socials) reason = 'no social links';
      } catch {
        reason = 'metadata unavailable';
      }
    }
    if (!reason && c.dev && c.devTokensRaw > 0n) {
      try {
        const bal = BigInt(await ctx.rpc.tokenBalanceRaw(c.dev, c.mint));
        if (bal < c.devTokensRaw / 2n) reason = 'creator sold';
      } catch {
        reason = 'could not check creator';
      }
    }
    c.vetted = reason;
    return reason;
  }

  async buy(ctx, c, s, usd, solUsd, info) {
    const { store, mode, cfg } = ctx;
    const lamports = BigInt(Math.floor((usd / solUsd) * 1e9));
    const tokens = haircut(curveBuy(s, lamports, cfg.PUMP_FEE_BPS), cfg.PUMP_PAPER_SLIPPAGE_BPS);
    if (tokens <= 0n) return false;
    const now = Date.now();
    const entry = usd / (Number(tokens) / 10 ** TOKEN_DECIMALS);
    await adjustPaperCash(ctx, -usd);
    await store.openPosition({ mode, mint: c.mint, symbol: c.symbol, decimals: TOKEN_DECIMALS, qty_raw: tokens.toString(), cost_usd: usd, entry_price: entry, opened_at: now, buy_sig: null });
    await store.set(curveKeyName(c.mint), c.curve);
    const why = `+${info.inflow.toFixed(1)} SOL in ${Math.round(info.age)}s, mcap ${info.mcap.toFixed(0)} SOL${info.expected != null ? `, expects ${(info.expected * 100).toFixed(0)}%` : ''}`;
    await store.addTrade({ mode, side: 'buy', mint: c.mint, symbol: c.symbol, usd, qty_raw: tokens.toString(), price: entry, reason: `pump: ${why}`, sig: null });
    await store.log('info', `BUY ${c.symbol} ${fmt(usd)} (${why}, ~$${Math.round(info.mcap * solUsd).toLocaleString()} mcap) https://pump.fun/coin/${c.mint}`);
    this.held.set(c.mint, { curve: c.curve, lastVSol: s.vSol, lastUpAt: now });
    this.watch.delete(c.mint);
    return true;
  }

  async tick(ctx, now = Date.now()) {
    if (this.busy) return { skipped: 'busy' };
    this.busy = true;
    try {
      return await this.#tick(ctx, now);
    } finally {
      this.busy = false;
    }
  }

  async #tick(ctx, now) {
    const { store, cfg, mode } = ctx;
    if (now - this.lastStatusAt >= 10e3) {
      this.lastStatusAt = now;
      const model = await this.loadModel(ctx, now);
      await store.set('pump_status', {
        feed: this.feedState, seen: this.seen, watching: this.watch.size, shadows: this.shadows.size,
        lastCoinAt: this.lastCoinAt, at: now, learn: summarize(model), learnMin: cfg.LEARN_MIN_LESSONS,
        board: boardRows(this.board ?? (this.board = await store.get(BOARD_KEY, null)), cfg.PUMP_TRADE_USD, activeTp(cfg, cfg.PUMP_TRADE_USD)),
      });
    }
    if (cfg.LIVE) {
      await this.warn(ctx, 'live', 'Pump mode is paper-only for now. Set LIVE_TRADING = "false" or use another STRATEGY.', 3600e3);
      return { skipped: 'live' };
    }
    await this.ensureFeed(ctx, now);

    // Open positions (only ones this engine bought have a stored curve).
    let positions = await store.positions(mode);
    const live = new Set(positions.map((p) => p.mint));
    for (const mint of this.held.keys()) if (!live.has(mint)) this.held.delete(mint);
    for (const p of positions) {
      if (this.held.has(p.mint)) continue;
      const curve = await store.get(curveKeyName(p.mint));
      if (curve) this.held.set(p.mint, { curve, lastVSol: null, lastUpAt: now });
    }

    for (const [mint, c] of this.watch) if (now - c.created > cfg.PUMP_MAX_AGE_SEC * 1000) this.watch.delete(mint);

    // One batched on-chain read for everything.
    const heldList = [...this.held.entries()];
    const watchList = [...this.watch.values()];
    const shadowList = [...this.shadows.entries()];
    const keys = [...heldList.map(([, h]) => h.curve), ...watchList.map((c) => c.curve), ...shadowList.map(([, sh]) => sh.curve)];
    let samples = [];
    if (keys.length) {
      try {
        samples = (await ctx.rpc.multipleAccounts(keys)).map(decodeCurve);
      } catch (e) {
        await this.warn(ctx, 'rpc', `Solana RPC: ${e.message} (all endpoints failed; set SOLANA_RPC_URL to a free Helius URL)`);
        return { error: 'rpc' };
      }
    }
    const solUsd = await solPrice(ctx, solCache);
    if (!solUsd) {
      await this.warn(ctx, 'sol', 'No SOL price yet; waiting.');
      return { error: 'sol price' };
    }

    // 1) Manage open positions.
    let heldValue = 0;
    const byMint = new Map(positions.map((p) => [p.mint, p]));
    for (let i = 0; i < heldList.length; i++) {
      const [mint, h] = heldList[i];
      const s = samples[i];
      const p = byMint.get(mint);
      if (!p) continue;
      if (s?.complete || await store.get(migrationKeyName(mint), false)) {
        const result = await sellPumpPosition(ctx, p, 'graduated', s);
        if (result.ok) this.held.delete(mint);
        else heldValue += (Number(BigInt(p.qty_raw)) / 10 ** p.decimals) * (p.last_price || p.entry_price);
        continue;
      }
      if (!s) {
        heldValue += (Number(BigInt(p.qty_raw)) / 10 ** p.decimals) * (p.last_price || p.entry_price);
        continue;
      }
      if (h.lastVSol === null || s.vSol > h.lastVSol) h.lastUpAt = now;
      h.lastVSol = s.vSol;
      const value = sellValueUsd(s, BigInt(p.qty_raw), cfg, solUsd);
      const price = value / (Number(BigInt(p.qty_raw)) / 10 ** TOKEN_DECIMALS);
      const peak = Math.max(p.peak_price || p.entry_price, price);
      const reason = pumpExit(p, price, peak, s, h.lastUpAt, cfg, now, activeTp(cfg, p.cost_usd));
      if (reason) {
        await sellPumpPosition(ctx, p, reason, s);
        this.held.delete(mint);
      } else {
        heldValue += value;
        if (price !== p.last_price || peak !== p.peak_price) await store.updatePrice(mode, mint, price, peak);
      }
    }
    positions = await store.positions(mode);

    // 1b) Finish shadow trades with the same exit rules, and learn from them.
    for (let i = 0; i < shadowList.length; i++) {
      const [mint, sh] = shadowList[i];
      const s = samples[heldList.length + watchList.length + i];
      if (s?.complete) sh.migrated = true;
      if (sh.migrated) {
        try {
          const value = await migratedValueUsd(ctx, mint, sh.tokens);
          const ret = value / sh.cost - 1;
          const active = activeTp(cfg, sh.cost);
          const results = { none: ret };
          for (const l of active !== null && !TP_LEVELS.includes(active) ? [...TP_LEVELS, active] : TP_LEVELS) results[tpKey(l)] = sh.tp[tpKey(l)] ?? ret;
          this.board = await saveBoard(store, results);
          if (!sh.twin) {
            this.model = await saveLesson(store, sh.feats, results[tpKey(active)] ?? ret, 'shadow');
            this.modelAt = now;
          }
          this.shadows.delete(mint);
        } catch {
          // Migration/indexing can take time. No invented exit or lesson while no route exists.
        }
        continue;
      }
      if (!s) {
        if (now - sh.opened_at > cfg.PUMP_MAX_HOLD_MIN * 60e3 * 2) this.shadows.delete(mint);
        continue;
      }
      if (s.vSol > sh.lastVSol) sh.lastUpAt = now;
      sh.lastVSol = s.vSol;
      const value = sellValueUsd(s, sh.tokens, cfg, solUsd);
      const price = value / (Number(sh.tokens) / 10 ** TOKEN_DECIMALS);
      sh.peak = Math.max(sh.peak, price);
      // Note the first moment each take-profit target would have been hit...
      const ret = value / sh.cost - 1;
      const active = activeTp(cfg, sh.cost);
      const levels = active !== null && !TP_LEVELS.includes(active) ? [...TP_LEVELS, active] : TP_LEVELS;
      for (const l of levels) if (sh.tp[tpKey(l)] === undefined && ret >= l) sh.tp[tpKey(l)] = ret;
      // ...and keep following it until the other exits fire, so higher targets get scored too.
      if (pumpExit(sh, price, sh.peak, s, sh.lastUpAt, cfg, now)) {
        const results = { none: ret };
        for (const l of levels) results[tpKey(l)] = sh.tp[tpKey(l)] ?? ret;
        this.board = await saveBoard(store, results);
        if (!sh.twin) {
          this.model = await saveLesson(store, sh.feats, results[tpKey(active)] ?? ret, 'shadow');
          this.modelAt = now;
        }
        this.shadows.delete(mint);
      }
    }

    // 2) Equity and daily loss guard.
    const cash = await store.get('paper_cash', cfg.PAPER_START_USD);
    const otherValue = positions.filter((p) => !this.held.has(p.mint)).reduce((t, p) => t + (Number(BigInt(p.qty_raw)) / 10 ** p.decimals) * (p.last_price || p.entry_price), 0);
    const equity = cash + heldValue + otherValue;
    if (now - (await store.get(`last_equity_ts_${mode}`, 0)) >= 60e3) {
      await store.recordEquity(mode, equity);
      await store.set(`last_equity_ts_${mode}`, now);
    }
    const dk = dayKey(mode, now);
    let dayStart = await store.get(dk);
    if (dayStart === null) {
      dayStart = equity;
      await store.set(dk, equity);
    }
    const halted = dayStart > 0 && equity / dayStart - 1 <= -cfg.DAILY_LOSS_LIMIT_PCT;
    if (halted && !(await store.get(`${dk}_halt_logged`))) {
      await store.set(`${dk}_halt_logged`, true);
      await store.log('warn', `Daily loss limit hit. No new buys until tomorrow (UTC).`);
    }
    const paused = await store.get('paused', false);

    // 3) Watch new coins and buy the best.
    const picks = [];
    for (let i = 0; i < watchList.length; i++) {
      const c = watchList[i];
      const s = samples[heldList.length + i];
      if (!s) continue;
      const price = curvePriceSol(s);
      c.hist.push({ t: now, price });
      if (c.hist.length > 8) c.hist.shift();
      c.peak = Math.max(c.peak, price);
      const r = pumpEntry(c, s, cfg, now);
      if (r === 'dead') this.watch.delete(c.mint);
      else if (r) picks.push({ c, s, ...r });
    }
    picks.sort((a, b) => b.score - a.score);
    let slots = cfg.MAX_POSITIONS - positions.length;
    let available = cash;
    let bought = 0;
    const model = await this.loadModel(ctx, now);
    const trained = (model?.n || 0) >= cfg.LEARN_MIN_LESSONS;
    for (const pick of picks) {
      const c = pick.c;
      if (this.shadows.has(c.mint)) continue;
      if (await store.cooldownActive(mode, c.mint, now)) {
        this.watch.delete(c.mint);
        continue;
      }
      const skip = await this.vet(ctx, c);
      if (skip) {
        await store.log('info', `Skip ${c.symbol}: ${skip}`);
        this.watch.delete(c.mint);
        continue;
      }
      const feats = featuresOf({ age: pick.age, inflow: pick.inflow, mcap: pick.mcap, rise: pick.rise, devPct: c.devPct, socials: c.socials ?? 1, now });
      const pred = predict(model, feats);
      const learnedSkip = trained && pred.expected !== null && pred.expected * 100 < cfg.LEARN_MIN_EDGE_PCT;
      const usd = Math.min(cfg.PUMP_TRADE_USD, available - cfg.CASH_RESERVE_USD);
      const canBuy = !paused && !halted && slots > 0 && usd >= cfg.MIN_TRADE_USD;
      if (canBuy && !learnedSkip) {
        if (await this.buy(ctx, c, pick.s, usd, solUsd, { ...pick, expected: trained ? pred.expected : null })) {
          await store.set(featKeyName(c.mint), feats);
          this.addShadow(c, pick.s, feats, solUsd, cfg, now, true); // scores every target for this coin too
          slots--;
          bought++;
          available -= usd;
        }
        continue;
      }
      // Not buying: follow it anyway so the bot learns whether it should have.
      if (learnedSkip) {
        const worst = pred.reasons.filter((r) => r.effect < 0).slice(0, 2).map((r) => r.label).join(', ');
        await store.log('info', `Skip ${c.symbol}: learned this kind of setup loses (expected ${(pred.expected * 100).toFixed(0)}% from ${model.n} lessons${worst ? `; worst: ${worst}` : ''})`);
      }
      this.addShadow(c, pick.s, feats, solUsd, cfg, now);
      this.watch.delete(c.mint);
    }

    return { mode, equity, cash, positions: positions.length, watching: this.watch.size, bought, paused, halted };
  }
}

