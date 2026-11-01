// Jupiter Perps bot: goes long or short on SOL, ETH and BTC with leverage.
//
// How it decides:
// 1. Pulls hourly candles (Coinbase's free public API, same prices Jupiter's oracles track).
// 2. Backtests three simple long/short strategies on each market over the last ~2 months,
//    charging Jupiter Perps' real costs: open + close fees, slippage, and hourly borrow fees.
// 3. Only trades a strategy on a market if that backtest made money after costs, made money
//    in the most recent half too (so one lucky stretch can't switch it on), and its own paper
//    trades haven't gone negative since. The backtest re-runs every day.
// 4. Watches open positions every few seconds with Jupiter's live price: stop loss,
//    trailing stop, take profit, max hold time, and a liquidation check.
//
// Paper only. Opening real Jupiter Perps positions needs the perps program's request
// instructions, which this bot does not send; LIVE_TRADING is ignored for perps.

export const MARKETS = [
  { sym: 'SOL', mint: 'So11111111111111111111111111111111111111112', cb: 'SOL-USD' },
  { sym: 'ETH', mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', cb: 'ETH-USD' },
  { sym: 'BTC', mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', cb: 'BTC-USD' },
];

const HOUR = 3600e3;
const MODE = 'perp';

const DEFAULTS = {
  PAPER_START_USD: 1000,
  PERP_COLLATERAL_USD: 100, // margin put up per trade
  PERP_LEVERAGE: 2, // position size = collateral × leverage
  PERP_MAX_POSITIONS: 3,
  PERP_OPEN_FEE_PCT: 0.0006, // Jupiter Perps: 0.06% of size to open
  PERP_CLOSE_FEE_PCT: 0.0006, // and 0.06% to close
  PERP_SLIPPAGE_PCT: 0.0003, // price impact + oracle drift per side
  PERP_BORROW_HR_PCT: 0.0001, // borrow fee per hour, as a share of size (conservative)
  PERP_MAINT_PCT: 0.002, // liquidated when remaining collateral falls under this share of size
  PERP_DAILY_LOSS_LIMIT_PCT: 0.05, // stop opening trades after losing 5% of equity in a day
  PERP_BT_PAGES: 5, // 300 hourly candles per page → 5 pages ≈ 62 days
  PERP_MIN_BT_TRADES: 8,
  PERP_MIN_BT_PF: 1.15, // backtest profit factor needed to trade a strategy
  PERP_LIVE_CHECK_TRADES: 8, // after this many paper trades, a strategy must stay profitable
  TICK_SECONDS: 5,
};

export function loadPerpsConfig(env = {}) {
  const cfg = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = Number(env[k]);
    cfg[k] = env[k] === undefined || env[k] === '' || Number.isNaN(v) ? def : v;
  }
  cfg.PERP_LEVERAGE = Math.min(Math.max(cfg.PERP_LEVERAGE, 1.1), 10);
  cfg.LIVE_REQUESTED = String(env.LIVE_TRADING || '').toLowerCase() === 'true';
  return cfg;
}

// ---------------------------------------------------------------- indicators

export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) continue;
    if (prev === null) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += values[j];
      prev = s / n;
    } else prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function atr(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  let prev = null;
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].c;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (i <= n) {
      sum += tr;
      if (i === n) out[i] = prev = sum / n;
    } else out[i] = prev = (prev * (n - 1) + tr) / n;
  }
  return out;
}

export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let up = 0;
  let dn = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const u = Math.max(d, 0);
    const w = Math.max(-d, 0);
    if (i <= n) {
      up += u / n;
      dn += w / n;
      if (i < n) continue;
    } else {
      up = (up * (n - 1) + u) / n;
      dn = (dn * (n - 1) + w) / n;
    }
    out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  return out;
}

export function indicators(bars) {
  const c = bars.map((b) => b.c);
  return { c, ema12: ema(c, 12), ema20: ema(c, 20), ema48: ema(c, 48), ema50: ema(c, 50), ema200: ema(c, 200), atr: atr(bars, 14), rsi: rsi(c, 14) };
}

export const WARMUP = 205;

// ---------------------------------------------------------------- strategies

const hiLo = (bars, i, n) => {
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i - n; j < i; j++) {
    hi = Math.max(hi, bars[j].h);
    lo = Math.min(lo, bars[j].l);
  }
  return { hi, lo };
};

export const STRATEGIES = {
  breakout: {
    label: 'Breakout',
    about: 'buys a new 24h high / shorts a new 24h low in the trend direction',
    stopAtr: 2, trailAtr: 3, takeAtr: null, maxHoldH: 72, exitOnOpposite: true,
    signal(bars, x, i) {
      const { hi, lo } = hiLo(bars, i, 24);
      const up = x.ema50[i] > x.ema50[i - 5];
      if (x.c[i] > hi && up) return 'long';
      if (x.c[i] < lo && !up) return 'short';
      return null;
    },
  },
  trend: {
    label: 'Trend',
    about: 'follows 12h/48h moving-average crossovers both ways',
    stopAtr: 2.5, trailAtr: 4, takeAtr: null, maxHoldH: 168, exitOnOpposite: true,
    signal(bars, x, i) {
      const was = x.ema12[i - 1] - x.ema48[i - 1];
      const now = x.ema12[i] - x.ema48[i];
      if (was <= 0 && now > 0) return 'long';
      if (was >= 0 && now < 0) return 'short';
      return null;
    },
  },
  reversion: {
    label: 'Snap-back',
    about: 'buys oversold dips in an uptrend / shorts overbought pops in a downtrend',
    stopAtr: 2, trailAtr: null, takeAtr: 1.5, maxHoldH: 24, exitOnOpposite: false,
    signal(bars, x, i) {
      if (x.rsi[i] < 25 && x.c[i] > x.ema200[i]) return 'long';
      if (x.rsi[i] > 75 && x.c[i] < x.ema200[i]) return 'short';
      return null;
    },
  },
};

// ---------------------------------------------------------------- position math

export function openPos({ market, side, strat, price, atrNow, at, cfg }) {
  const s = STRATEGIES[strat];
  const dir = side === 'long' ? 1 : -1;
  const collateral = cfg.PERP_COLLATERAL_USD;
  return {
    market, side, strat, entry: price, atr: atrNow, opened_at: at,
    collateral, size: collateral * cfg.PERP_LEVERAGE,
    stop: price - dir * s.stopAtr * atrNow,
    take: s.takeAtr ? price + dir * s.takeAtr * atrNow : null,
    peak: price, last_price: price,
  };
}

/** What the position is worth if closed at `price`, after every fee. */
export function valueAt(p, price, at, cfg) {
  const dir = p.side === 'long' ? 1 : -1;
  const pnl = p.size * dir * (price / p.entry - 1);
  const hours = Math.max(0, (at - p.opened_at) / HOUR);
  const openFee = p.size * (cfg.PERP_OPEN_FEE_PCT + cfg.PERP_SLIPPAGE_PCT);
  const closeFee = p.size * (cfg.PERP_CLOSE_FEE_PCT + cfg.PERP_SLIPPAGE_PCT);
  const borrow = p.size * cfg.PERP_BORROW_HR_PCT * hours;
  const remaining = p.collateral - openFee + pnl - borrow; // margin left in the position
  const liquidated = remaining <= p.size * cfg.PERP_MAINT_PCT + closeFee;
  const net = liquidated ? -p.collateral : pnl - openFee - closeFee - borrow;
  return { pnl, net, ret: net / p.collateral, liquidated, fees: openFee + closeFee + borrow };
}

/** Price at which the position would be liquidated (ignoring borrow fees still to come). */
export function liqPrice(p, cfg) {
  const dir = p.side === 'long' ? 1 : -1;
  const fees = p.size * (cfg.PERP_OPEN_FEE_PCT + cfg.PERP_CLOSE_FEE_PCT + 2 * cfg.PERP_SLIPPAGE_PCT);
  const room = p.collateral - fees - p.size * cfg.PERP_MAINT_PCT;
  return p.entry * (1 - (dir * room) / p.size);
}

/** Move the trailing stop with the best price seen. Returns the updated position. */
export function trail(p, price) {
  const s = STRATEGIES[p.strat];
  const long = p.side === 'long';
  const peak = long ? Math.max(p.peak, price) : Math.min(p.peak, price);
  let stop = p.stop;
  if (s.trailAtr) stop = long ? Math.max(stop, peak - s.trailAtr * p.atr) : Math.min(stop, peak + s.trailAtr * p.atr);
  return { ...p, peak, stop };
}

/** Exit check for a live tick price. */
export function exitCheck(p, price, at, cfg) {
  const s = STRATEGIES[p.strat];
  const long = p.side === 'long';
  if (valueAt(p, price, at, cfg).liquidated) return 'liquidated';
  if (long ? price <= p.stop : price >= p.stop) return (long ? p.stop > p.entry : p.stop < p.entry) ? 'trailing stop' : 'stop loss';
  if (p.take && (long ? price >= p.take : price <= p.take)) return 'take profit';
  if (at - p.opened_at >= s.maxHoldH * HOUR) return 'max hold time';
  return null;
}

// ---------------------------------------------------------------- backtest

export function backtest(bars, strat, cfg) {
  const s = STRATEGIES[strat];
  const x = indicators(bars);
  const trades = [];
  let p = null;
  const close = (price, at, why) => {
    const v = valueAt(p, price, at, cfg);
    trades.push({ side: p.side, at, ret: v.ret, net: v.net, why });
    p = null;
  };
  for (let i = WARMUP; i < bars.length; i++) {
    const b = bars[i];
    const end = b.t + HOUR;
    if (p) {
      const long = p.side === 'long';
      // Within the bar: assume the worst — the stop is hit before the target.
      const gapStop = long ? b.o <= p.stop : b.o >= p.stop;
      const hitStop = long ? b.l <= p.stop : b.h >= p.stop;
      const hitTake = p.take && (long ? b.h >= p.take : b.l <= p.take);
      const liq = liqPrice(p, cfg);
      const hitLiq = long ? b.l <= liq : b.h >= liq;
      if (hitLiq && (long ? liq >= p.stop : liq <= p.stop)) close(liq, end, 'liquidated');
      else if (gapStop) close(b.o, end, 'stop');
      else if (hitStop) close(p.stop, end, 'stop');
      else if (hitTake) close(p.take, end, 'take profit');
      else {
        p = trail(p, long ? b.h : b.l);
        if (end - p.opened_at >= s.maxHoldH * HOUR) close(b.c, end, 'max hold');
      }
    }
    const sig = x.atr[i] ? s.signal(bars, x, i) : null;
    if (p && sig && s.exitOnOpposite && sig !== p.side) close(b.c, end, 'opposite signal');
    if (!p && sig) p = openPos({ market: '', side: sig, strat, price: b.c, atrNow: x.atr[i], at: end, cfg });
  }
  return summarize(trades);
}

export function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.net > 0).length;
  const gw = trades.reduce((a, t) => a + Math.max(t.net, 0), 0);
  const gl = trades.reduce((a, t) => a + Math.max(-t.net, 0), 0);
  const total = trades.reduce((a, t) => a + t.net, 0);
  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of trades) {
    eq += t.net;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
  }
  const half = Math.floor(n / 2);
  const recent = trades.slice(half).reduce((a, t) => a + t.net, 0);
  return {
    n, wins, winRate: n ? wins / n : 0, total, avgRet: n ? trades.reduce((a, t) => a + t.ret, 0) / n : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? 99 : 0, maxDD, recent,
    longs: trades.filter((t) => t.side === 'long').length,
    liquidations: trades.filter((t) => t.why === 'liquidated').length,
  };
}

/** A strategy/market pair is tradeable only if the backtest earned money after costs, recently too. */
export function qualifies(r, cfg) {
  if (r.n < cfg.PERP_MIN_BT_TRADES) return 'too few trades to judge';
  if (r.total <= 0) return 'lost money after fees';
  if (r.pf < cfg.PERP_MIN_BT_PF) return `profit factor ${r.pf.toFixed(2)} under ${cfg.PERP_MIN_BT_PF}`;
  if (r.recent <= 0) return 'lost money in the most recent half';
  return null;
}

export function runBacktests(barsByMarket, cfg, at = Date.now()) {
  const results = {};
  for (const m of MARKETS) {
    const bars = barsByMarket[m.sym];
    for (const strat of Object.keys(STRATEGIES)) {
      const key = `${strat}:${m.sym}`;
      if (!bars || bars.length < WARMUP + 50) {
        results[key] = { n: 0, enabled: false, why: 'not enough price history' };
        continue;
      }
      const r = backtest(bars, strat, cfg);
      const why = qualifies(r, cfg);
      results[key] = { ...r, enabled: !why, why };
    }
  }
  const days = Math.round(Math.max(0, ...Object.values(barsByMarket).map((b) => b?.length || 0)) / 24);
  return { at, days, results };
}

// ---------------------------------------------------------------- data

/** Hourly candles, oldest first, completed bars only. */
export async function fetchBars(product, pages = 1, now = Date.now()) {
  const byT = new Map();
  let end = Math.floor(now / HOUR) * HOUR;
  for (let p = 0; p < pages; p++) {
    const start = end - 300 * HOUR;
    const q = new URLSearchParams({ granularity: '3600', start: new Date(start).toISOString(), end: new Date(end).toISOString() });
    const res = await fetch(`https://api.exchange.coinbase.com/products/${product}/candles?${q}`, {
      headers: { accept: 'application/json', 'user-agent': 'phantom-alt-bot' },
    });
    if (!res.ok) throw new Error(`candles ${product} HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    for (const [t, l, h, o, c] of rows) byT.set(t * 1000, { t: t * 1000, o, h, l, c });
    end = start;
  }
  return [...byT.values()].filter((b) => b.t + HOUR <= now).sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- storage

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS perp_positions (
     market TEXT PRIMARY KEY, side TEXT, strat TEXT, entry REAL, size REAL, collateral REAL, atr REAL,
     stop REAL, take REAL, peak REAL, last_price REAL, opened_at INTEGER)`,
];

const COLS = ['market', 'side', 'strat', 'entry', 'size', 'collateral', 'atr', 'stop', 'take', 'peak', 'last_price', 'opened_at'];

async function ensureSchema(db) {
  for (const s of SCHEMA) await db.prepare(s).run();
}

async function savePos(db, p) {
  await db
    .prepare(`INSERT OR REPLACE INTO perp_positions (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`)
    .bind(...COLS.map((c) => p[c] ?? null))
    .run();
}

async function loadPositions(db) {
  await ensureSchema(db);
  return (await db.prepare('SELECT * FROM perp_positions ORDER BY opened_at').all()).results || [];
}

async function perpStats(db) {
  return db
    .prepare(
      `SELECT COUNT(*) AS sells, COALESCE(SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END), 0) AS wins,
              COALESCE(SUM(pnl_usd), 0) AS realized,
              COALESCE(SUM(CASE WHEN pnl_usd > 0 THEN pnl_usd ELSE 0 END), 0) AS gross_win,
              COALESCE(SUM(CASE WHEN pnl_usd < 0 THEN -pnl_usd ELSE 0 END), 0) AS gross_loss
       FROM trades WHERE mode = ? AND side = 'close'`,
    )
    .bind(MODE)
    .first();
}

const fmt = (n) => `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(2)}`;
const dayKey = (now) => `perp_day_start_${new Date(now).toISOString().slice(0, 10)}`;
const marketOf = (sym) => MARKETS.find((m) => m.sym === sym);

// ---------------------------------------------------------------- engine

export class PerpsEngine {
  constructor(env) {
    this.env = env;
    this.cfg = loadPerpsConfig(env);
    this.bars = {}; // sym -> bars (in memory between ticks)
    this.barHour = 0; // last completed hour we evaluated signals on
    this.lastEquity = 0;
    this.warnedLive = false;
  }

  async cash(store) {
    return store.get('perp_cash', this.cfg.PAPER_START_USD);
  }

  async prices(ctx) {
    const out = {};
    try {
      const r = await ctx.jup.prices(MARKETS.map((m) => m.mint));
      for (const m of MARKETS) if (r[m.mint]?.usdPrice) out[m.sym] = Number(r[m.mint].usdPrice);
    } catch (e) {
      this.priceErr = e.message;
    }
    for (const m of MARKETS) if (!out[m.sym] && this.bars[m.sym]?.length) out[m.sym] = this.bars[m.sym].at(-1).c;
    return out;
  }

  async refreshBacktest(ctx, now) {
    const { store } = ctx;
    const bars = {};
    for (const m of MARKETS) {
      try {
        bars[m.sym] = await fetchBars(m.cb, this.cfg.PERP_BT_PAGES, now);
      } catch (e) {
        await store.log('warn', `Perps: couldn't load ${m.sym} price history (${e.message})`);
      }
    }
    if (!Object.keys(bars).length) return null;
    const bt = runBacktests(bars, this.cfg, now);
    await store.set('perp_backtest', bt);
    for (const [k, v] of Object.entries(bars)) this.bars[k] = v.slice(-400);
    const on = Object.entries(bt.results).filter(([, r]) => r.enabled).map(([k]) => k.replace(':', ' on '));
    await store.log('info', on.length
      ? `Perps backtest (${bt.days} days): trading ${on.join(', ')}`
      : `Perps backtest (${bt.days} days): no strategy made money after fees, so it won't open trades`);
    return bt;
  }

  async allowed(store, key) {
    const bt = await store.get('perp_backtest', null);
    const r = bt?.results?.[key];
    if (!r?.enabled) return false;
    const rec = (await store.get('perp_record', {}))[key];
    if (rec && rec.n >= this.cfg.PERP_LIVE_CHECK_TRADES && rec.sum <= 0) return false;
    return true;
  }

  async open(ctx, m, side, strat, price, atrNow, now) {
    const { store, env } = ctx;
    const cash = await this.cash(store);
    if (cash < this.cfg.PERP_COLLATERAL_USD) return false;
    const p = openPos({ market: m.sym, side, strat, price, atrNow, at: now, cfg: this.cfg });
    await savePos(env.DB, p);
    await store.set('perp_cash', cash - p.collateral);
    await store.addTrade({ mode: MODE, side, mint: m.sym, symbol: `${m.sym} ${side.toUpperCase()} ${this.cfg.PERP_LEVERAGE}x`, usd: p.collateral, qty_raw: String(p.size), price, reason: STRATEGIES[strat].label });
    await store.log('info', `Opened ${m.sym} ${side} ${this.cfg.PERP_LEVERAGE}x at $${price.toFixed(2)} ($${p.collateral} margin, $${p.size} size) · ${STRATEGIES[strat].label} · stop $${p.stop.toFixed(2)} · liquidation ~$${liqPrice(p, this.cfg).toFixed(2)}`);
    return true;
  }

  async close(ctx, p, price, why, now = Date.now()) {
    const { store, env } = ctx;
    const v = valueAt(p, price, now, this.cfg);
    await env.DB.prepare('DELETE FROM perp_positions WHERE market = ?').bind(p.market).run();
    await store.set('perp_cash', (await this.cash(store)) + Math.max(0, p.collateral + v.net));
    await store.addTrade({ mode: MODE, side: 'close', mint: p.market, symbol: `${p.market} ${p.side.toUpperCase()}`, usd: p.collateral + v.net, qty_raw: String(p.size), price, pnl_usd: v.net, reason: why });
    const key = `${p.strat}:${p.market}`;
    const rec = await store.get('perp_record', {});
    rec[key] = { n: (rec[key]?.n || 0) + 1, sum: (rec[key]?.sum || 0) + v.net };
    await store.set('perp_record', rec);
    await store.log(v.net >= 0 ? 'info' : 'warn', `Closed ${p.market} ${p.side} at $${price.toFixed(2)}: ${fmt(v.net)} (${(v.ret * 100).toFixed(1)}% on margin, $${v.fees.toFixed(2)} fees) · ${why}`);
    return { ok: true, pnl: v.net };
  }

  async equity(ctx, prices, now) {
    const positions = await loadPositions(ctx.env.DB);
    let held = 0;
    for (const p of positions) held += Math.max(0, p.collateral + valueAt(p, prices[p.market] ?? p.last_price, now, this.cfg).net);
    return (await this.cash(ctx.store)) + held;
  }

  /** One pass: manage positions every tick; look for entries once per completed hour. */
  async tick(ctx, { force = false } = {}) {
    const { store, env } = ctx;
    const cfg = this.cfg;
    const now = Date.now();
    await ensureSchema(env.DB);
    if (cfg.LIVE_REQUESTED && !this.warnedLive) {
      this.warnedLive = true;
      await store.log('warn', 'Perps run in paper mode only — LIVE_TRADING is ignored for perps');
    }

    let bt = await store.get('perp_backtest', null);
    if (force || !bt || now - bt.at > 24 * HOUR) {
      bt = await this.refreshBacktest(ctx, now);
      return { backtest: !!bt };
    }

    const prices = await this.prices(ctx);
    const positions = await loadPositions(env.DB);
    for (let p of positions) {
      const price = prices[p.market];
      if (!price) continue;
      p = trail(p, price);
      const why = exitCheck(p, price, now, cfg);
      if (why) await this.close(ctx, p, price, why, now);
      else await savePos(env.DB, { ...p, last_price: price });
    }

    // Entries: once each hour, a minute after the candle closes.
    const hour = Math.floor((now - 60e3) / HOUR) * HOUR;
    const opened = [];
    if (!this.barHour) this.barHour = await store.get('perp_bar_hour', 0);
    if (hour > this.barHour) {
      this.barHour = hour;
      await store.set('perp_bar_hour', hour);
      const eqNow = await this.equity(ctx, prices, now);
      const dk = dayKey(now);
      let dayStart = await store.get(dk, null);
      if (dayStart === null) await store.set(dk, (dayStart = eqNow));
      const paused = await store.get('paused', false);
      const lossHit = eqNow <= dayStart * (1 - cfg.PERP_DAILY_LOSS_LIMIT_PCT);
      for (const m of MARKETS) {
        let bars;
        try {
          bars = await fetchBars(m.cb, 1, now);
        } catch (e) {
          await store.log('warn', `Perps: ${m.sym} candles failed (${e.message})`);
          continue;
        }
        if (bars.length < WARMUP + 1) continue;
        this.bars[m.sym] = bars;
        const x = indicators(bars);
        const i = bars.length - 1;
        const price = prices[m.sym] || bars[i].c;
        let held = (await loadPositions(env.DB)).find((p) => p.market === m.sym);
        // Opposite signal closes a trend/breakout position.
        if (held && STRATEGIES[held.strat].exitOnOpposite) {
          const sig = STRATEGIES[held.strat].signal(bars, x, i);
          if (sig && sig !== held.side) {
            await this.close(ctx, held, price, 'opposite signal', now);
            held = null;
          }
        }
        if (held || paused || lossHit) continue;
        if ((await loadPositions(env.DB)).length >= cfg.PERP_MAX_POSITIONS) continue;
        for (const strat of Object.keys(STRATEGIES)) {
          const sig = STRATEGIES[strat].signal(bars, x, i);
          if (!sig || !x.atr[i]) continue;
          if (!(await this.allowed(store, `${strat}:${m.sym}`))) continue;
          if (await this.open(ctx, m, sig, strat, price, x.atr[i], now)) opened.push(`${m.sym} ${sig}`);
          break;
        }
      }
      if (lossHit) await store.log('warn', `Perps: down ${(cfg.PERP_DAILY_LOSS_LIMIT_PCT * 100).toFixed(0)}% today, no new trades until tomorrow`);
    }

    if (now - this.lastEquity >= 60e3) {
      this.lastEquity = now;
      await store.recordEquity(MODE, await this.equity(ctx, prices, now));
    }
    return { opened };
  }
}

/** Close one position by market symbol (dashboard button). */
export async function closePerp(ctx, sym, why = 'manual') {
  const engine = new PerpsEngine(ctx.env);
  const p = (await loadPositions(ctx.env.DB)).find((x) => x.market === sym);
  if (!p) return { error: 'no such position' };
  const prices = await engine.prices(ctx);
  return engine.close(ctx, p, prices[sym] ?? p.last_price, why);
}

export async function closeAllPerps(ctx) {
  const out = [];
  for (const p of await loadPositions(ctx.env.DB)) out.push({ symbol: p.market, ...(await closePerp(ctx, p.market, 'close all')) });
  return out;
}

export async function resetPerps(ctx) {
  const db = ctx.env.DB;
  await ensureSchema(db);
  await db.batch([
    db.prepare('DELETE FROM perp_positions'),
    db.prepare("DELETE FROM trades WHERE mode = 'perp'"),
    db.prepare("DELETE FROM equity WHERE mode = 'perp'"),
    db.prepare("DELETE FROM state WHERE k = 'perp_cash' OR k = 'perp_record' OR k LIKE 'perp_day_start_%'"),
  ]);
}

export async function perpsState(ctx) {
  const { store, env } = ctx;
  const cfg = loadPerpsConfig(env);
  const engine = new PerpsEngine(env);
  const now = Date.now();
  const positions = await loadPositions(env.DB);
  const cash = await engine.cash(store);
  const pos = positions.map((p) => {
    const price = p.last_price || p.entry;
    const v = valueAt(p, price, now, cfg);
    return {
      mint: p.market, symbol: `${p.market} ${p.side.toUpperCase()} ${(p.size / p.collateral).toFixed(0)}x`, side: p.side,
      cost: p.collateral, value: Math.max(0, p.collateral + v.net), pnl: v.net, pnlPct: v.ret,
      entry: p.entry, price, stop: p.stop, take: p.take, liq: liqPrice(p, cfg), strat: STRATEGIES[p.strat]?.label, openedAt: p.opened_at,
    };
  });
  const equity = cash + pos.reduce((a, p) => a + p.value, 0);
  const dayStart = await store.get(dayKey(now), null);
  const history = await store.equityHistory(MODE, now - 7 * 86400e3);
  const step = Math.max(1, Math.ceil(history.length / 300));
  const bt = await store.get('perp_backtest', null);
  const record = await store.get('perp_record', {});
  return {
    mode: 'paper', wallet: null, paused: await store.get('paused', false), cash, equity, startEquity: cfg.PAPER_START_USD,
    dayChange: dayStart ? equity / dayStart - 1 : 0, positions: pos,
    trades: (await store.trades(MODE, 50)).map((t) => ({ ...t, side: t.side === 'close' ? 'close' : t.side })),
    events: await store.events(40), stats: await perpStats(env.DB), lastScanNote: null,
    history: history.filter((_, i) => i % step === 0 || i === history.length - 1),
    rules: {
      strategy: 'perps',
      perps: {
        collateral: cfg.PERP_COLLATERAL_USD, leverage: cfg.PERP_LEVERAGE, maxPositions: cfg.PERP_MAX_POSITIONS,
        fees: cfg.PERP_OPEN_FEE_PCT + cfg.PERP_CLOSE_FEE_PCT + 2 * cfg.PERP_SLIPPAGE_PCT, borrowHr: cfg.PERP_BORROW_HR_PCT,
        dailyLossLimit: cfg.PERP_DAILY_LOSS_LIMIT_PCT, tickSeconds: cfg.TICK_SECONDS,
        strategies: Object.fromEntries(Object.entries(STRATEGIES).map(([k, s]) => [k, { label: s.label, about: s.about }])),
        markets: MARKETS.map((m) => m.sym), backtest: bt, record,
      },
    },
  };
}
