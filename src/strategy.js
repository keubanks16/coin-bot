// Strategy: fast, cost-aware scalping on established Solana altcoins.
//
// 1. Safety filter — skip anything that looks like a rug or a fresh launch.
// 2. Entry — a fresh 5-minute push driven by real (organic) buyers, inside a healthy 1h trend.
//    Every buy must also pass a round-trip cost check (quote in AND back out), so the bot
//    only scalps tokens where fees + slippage leave room for a profit.
// 3. Exit — tight stop, quick take profit, trailing stop, a "dead trade" timeout, and a max hold.
//
// STRATEGY = "scalp" (default), "momentum" (the original slower 1h swing strategy), or
// "pump" (snipes brand-new pump.fun coins; see src/pump.js).
// Every number here can be overridden with a wrangler.toml [vars] entry of the same name.

import { USDC, SOL } from './jupiter.js';

const COMMON = {
  PAPER_START_USD: 1000,
  POSITION_PCT: 0.15, // fraction of equity per new position
  MAX_POSITIONS: 4,
  MIN_TRADE_USD: 5,
  MAX_TRADE_USD: 250,
  CASH_RESERVE_USD: 2,
  DAILY_LOSS_LIMIT_PCT: 0.06, // stop opening trades for the day after this drawdown
  LOSS_STREAK_LIMIT: 4, // this many losing trades in a row...
  LOSS_STREAK_PAUSE_MIN: 60, // ...pauses new buys for this long
  TICK_SECONDS: 5, // how often open positions are re-priced (fast loop)
  SCAN_EVERY_SEC: 30, // how often to look for new entries
  JUP_RPS: 1, // Jupiter API key budget (free key = 1/sec). Raise if you upgrade your key.
  MAX_ROUNDTRIP_COST_PCT: 0.006, // reject a buy if buying+selling right away would lose more than this
  MIN_PROFIT_TO_COST: 3, // take profit must be at least this many times the round-trip cost
  MIN_LIQUIDITY_USD: 300000,
  MIN_MCAP_USD: 1000000,
  MIN_ORGANIC_SCORE: 60,
  MAX_TOP_HOLDERS_PCT: 35,
  MIN_TOKEN_AGE_HOURS: 48,
  PAPER_SLIPPAGE_BPS: 30, // extra haircut on paper fills so paper isn't rosier than live
  SCAN_INTERVAL: 0, // 0 = strategy default (5m for scalp, 1h for momentum)
};

// Settings for STRATEGY = "pump" (new pump.fun coins). Always loaded; only used in pump mode.
const PUMP = {
  PUMP_TRADE_USD: 20, // size of each pump.fun buy
  PUMP_MAX_POSITIONS: 3,
  PUMP_POLL_SECONDS: 2, // how often watched coins and open positions are re-read on-chain
  PUMP_MIN_AGE_SEC: 10, // ignore a coin's first seconds (bundled launch buys)
  PUMP_MAX_AGE_SEC: 180, // only buy coins younger than this
  PUMP_MIN_INFLOW_SOL: 3, // SOL other traders put in since launch (excludes the dev's own buy)
  PUMP_MAX_MCAP_SOL: 90, // "cheap": market cap at most this (launch is ~28 SOL, graduation ~410)
  PUMP_MIN_TICK_RISE_PCT: 1, // must be climbing right now: up this much vs. ~4 seconds ago
  PUMP_MAX_DEV_PCT: 10, // skip if the creator bought more than this % of supply at launch
  PUMP_REQUIRE_SOCIALS: 1, // 1 = needs a Twitter, Telegram or website link in its metadata
  PUMP_STOP_LOSS_PCT: 0.25,
  PUMP_TRAIL_ARM_PCT: 0.05, // once up this much...
  PUMP_DOWNTURN_PCT: 0.12, // ...sell on the first drop of this size from the peak
  PUMP_STALL_SEC: 45, // sell if nobody has bought for this long
  PUMP_MAX_HOLD_MIN: 10,
  PUMP_FEE_BPS: 125, // pump.fun protocol + creator fee per side (low-market-cap tier)
  PUMP_PAPER_SLIPPAGE_BPS: 300, // paper haircut per side: real snipers get in ahead of a 2s poll
  PUMP_MAX_SHADOWS: 40, // coins followed without money at once, to learn from (see src/learn.js)
  LEARN_MIN_LESSONS: 30, // after this many finished lessons, the model decides what to buy...
  LEARN_MIN_EDGE_PCT: 0, // ...and only buys setups it expects to return more than this (after fees)
};

const PROFILES = {
  pump: {
    STOP_LOSS_PCT: 0.25,
    TAKE_PROFIT_PCT: 10,
    TRAIL_ARM_PCT: 0.05,
    TRAIL_PCT: 0.12,
    STALE_MINUTES: 0,
    STALE_MIN_GAIN_PCT: 0,
    MAX_HOLD_HOURS: 10 / 60,
    COOLDOWN_HOURS: 24,
    LOSS_COOLDOWN_HOURS: 24,
    MIN_5M_CHANGE_PCT: 0,
    MAX_5M_CHANGE_PCT: 0,
    MIN_1H_CHANGE_PCT: 0,
    MAX_1H_CHANGE_PCT: 0,
    MIN_VOLUME_5M_USD: 0,
    MIN_VOLUME_1H_USD: 0,
    MIN_ORGANIC_BUY_RATIO: 0,
    LOSS_STREAK_LIMIT: 0, // most snipes lose; the daily loss limit is the guard here
  },
  scalp: {
    STOP_LOSS_PCT: 0.025,
    TAKE_PROFIT_PCT: 0.04,
    TRAIL_ARM_PCT: 0.015, // trailing stop activates after this gain...
    TRAIL_PCT: 0.01, // ...and sells if price falls this far from the peak
    STALE_MINUTES: 15, // a scalp that hasn't moved after this long...
    STALE_MIN_GAIN_PCT: 0.005, // ...(still below +0.5%) is closed to free the money
    MAX_HOLD_HOURS: 1,
    COOLDOWN_HOURS: 0.5,
    LOSS_COOLDOWN_HOURS: 4, // after a losing trade, leave that token alone this long
    MIN_5M_CHANGE_PCT: 1.2,
    MAX_5M_CHANGE_PCT: 5,
    MIN_1H_CHANGE_PCT: 2, // only buy pushes inside an hour-long uptrend
    MAX_1H_CHANGE_PCT: 20,
    MIN_VOLUME_5M_USD: 40000,
    MIN_VOLUME_1H_USD: 100000,
    MIN_ORGANIC_BUY_RATIO: 1.25, // organic buy volume / organic sell volume (5m)
  },
  momentum: {
    STOP_LOSS_PCT: 0.08,
    TAKE_PROFIT_PCT: 0.25,
    TRAIL_ARM_PCT: 0.1,
    TRAIL_PCT: 0.06,
    STALE_MINUTES: 0, // off
    STALE_MIN_GAIN_PCT: 0,
    MAX_HOLD_HOURS: 24,
    COOLDOWN_HOURS: 6,
    LOSS_COOLDOWN_HOURS: 6,
    MIN_5M_CHANGE_PCT: 0,
    MAX_5M_CHANGE_PCT: 6,
    MIN_1H_CHANGE_PCT: 3,
    MAX_1H_CHANGE_PCT: 25,
    MIN_VOLUME_5M_USD: 0,
    MIN_VOLUME_1H_USD: 50000,
    MIN_ORGANIC_BUY_RATIO: 1.15, // organic buy / sell volume (1h)
  },
};

export function loadConfig(env = {}) {
  const want = String(env.STRATEGY || 'scalp').toLowerCase();
  const strategy = PROFILES[want] ? want : 'scalp';
  const defaults = { ...COMMON, ...PUMP, ...PROFILES[strategy] };
  // Backwards compatibility with the old minute-based scan setting.
  if (env.SCAN_EVERY_SEC === undefined && env.SCAN_EVERY_MIN !== undefined && env.SCAN_EVERY_MIN !== '') {
    env = { ...env, SCAN_EVERY_SEC: String(Number(env.SCAN_EVERY_MIN) * 60) };
  }
  const cfg = {};
  for (const [k, def] of Object.entries(defaults)) {
    const v = env[k];
    cfg[k] = v === undefined || v === '' ? def : Number(v);
    if (Number.isNaN(cfg[k])) cfg[k] = def;
  }
  cfg.STRATEGY = strategy;
  cfg.SCAN_INTERVAL_NAME = strategy === 'scalp' ? '5m' : '1h';
  cfg.TICK_SECONDS = Math.max(2, strategy === 'pump' ? cfg.PUMP_POLL_SECONDS : cfg.TICK_SECONDS);
  if (strategy === 'pump') cfg.MAX_POSITIONS = cfg.PUMP_MAX_POSITIONS;
  cfg.LIVE = String(env.LIVE_TRADING || '').toLowerCase() === 'true';
  cfg.MODE = cfg.LIVE ? 'live' : 'paper';
  cfg.BLOCKLIST = new Set(
    String(env.BLOCKLIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return cfg;
}

const SKIP_MINTS = new Set([
  USDC,
  SOL,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
const SKIP_TAGS = new Set(['lst', 'stocks', 'stable', 'stablecoin']);

/** Returns null if the token passes, otherwise a short reason string. */
export function safetyReject(t, cfg, now = Date.now()) {
  if (!t || !t.id) return 'no data';
  if (SKIP_MINTS.has(t.id) || cfg.BLOCKLIST.has(t.id)) return 'excluded';
  if ((t.tags || []).some((tag) => SKIP_TAGS.has(String(tag).toLowerCase()))) return 'excluded tag';
  const a = t.audit || {};
  if (a.isSus) return 'flagged suspicious';
  if (a.mintAuthorityDisabled !== true) return 'mint authority active';
  if (a.freezeAuthorityDisabled !== true) return 'freeze authority active';
  if (typeof a.topHoldersPercentage === 'number' && a.topHoldersPercentage > cfg.MAX_TOP_HOLDERS_PCT) {
    return 'too concentrated';
  }
  if (!(t.usdPrice > 0)) return 'no price';
  if ((t.liquidity || 0) < cfg.MIN_LIQUIDITY_USD) return 'low liquidity';
  if ((t.mcap || 0) < cfg.MIN_MCAP_USD) return 'low mcap';
  if (!t.isVerified && (t.organicScore || 0) < cfg.MIN_ORGANIC_SCORE) return 'low organic score';
  const created = t.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : NaN;
  if (!Number.isFinite(created) || now - created < cfg.MIN_TOKEN_AGE_HOURS * 3600e3) return 'too new';
  return null;
}

const vol = (s) => (s?.buyVolume || 0) + (s?.sellVolume || 0);
const organicRatio = (s) => (s?.buyOrganicVolume || 0) / Math.max(s?.sellOrganicVolume || 0, 1);
const hasOrganic = (s) => s && (s.buyOrganicVolume !== undefined || s.sellOrganicVolume !== undefined);

/** Returns a positive score if the entry signal fires, otherwise null. */
export function entryScore(t, cfg) {
  const h = t.stats1h;
  const m = t.stats5m;
  if (!h || !m) return null;
  const ch1h = h.priceChange ?? 0;
  const ch5m = m.priceChange ?? 0;
  if (ch1h < cfg.MIN_1H_CHANGE_PCT || ch1h > cfg.MAX_1H_CHANGE_PCT) return null;
  if (ch5m < cfg.MIN_5M_CHANGE_PCT || ch5m > cfg.MAX_5M_CHANGE_PCT) return null; // rising, not spiking
  if (ch5m < 0) return null;
  if (vol(h) < cfg.MIN_VOLUME_1H_USD) return null;
  const organic = (t.organicScore || 0) / 100;

  if (cfg.STRATEGY === 'scalp') {
    // Need real flow right now: 5m volume, and organic buyers outweighing sellers in the last 5m
    // (falls back to 1h buy pressure if Jupiter didn't return 5m organic numbers).
    if (vol(m) < cfg.MIN_VOLUME_5M_USD) return null;
    const ratio = hasOrganic(m) ? organicRatio(m) : organicRatio(h);
    if (ratio < cfg.MIN_ORGANIC_BUY_RATIO) return null;
    if ((m.numNetBuyers ?? h.numNetBuyers ?? 0) <= 0) return null;
    // Turnover: how much of the pool traded in 5m. More turnover = tighter, faster fills.
    const turnover = Math.min(vol(m) / Math.max(t.liquidity || 1, 1), 1);
    return ch5m * Math.min(ratio, 3) * (0.5 + organic) * (0.5 + turnover);
  }

  const ratio = organicRatio(h);
  if (ratio < cfg.MIN_ORGANIC_BUY_RATIO) return null;
  if ((h.numNetBuyers || 0) <= 0) return null;
  return ch1h * Math.min(ratio, 3) * (0.5 + organic);
}

/**
 * Round-trip cost check from two real quotes: spend `usdIn`, get `tokensOut`, and selling
 * those tokens straight back would return `usdBack`. Returns null if OK, else a reason.
 */
export function costReject(usdIn, usdBack, cfg) {
  if (!(usdIn > 0) || !(usdBack > 0)) return 'no route back to USDC';
  const cost = 1 - usdBack / usdIn;
  if (cost > cfg.MAX_ROUNDTRIP_COST_PCT) return `round-trip cost ${(cost * 100).toFixed(2)}% too high`;
  if (cost > 0 && cfg.TAKE_PROFIT_PCT < cost * cfg.MIN_PROFIT_TO_COST) {
    return `take profit too small for ${(cost * 100).toFixed(2)}% round-trip cost`;
  }
  return null;
}

/**
 * Decide whether to close a position at the current price.
 * Returns { sell: bool, reason, peak }.
 */
export function exitDecision(pos, price, cfg, now = Date.now()) {
  const peak = Math.max(pos.peak_price || pos.entry_price, price);
  const pnl = price / pos.entry_price - 1;
  const peakGain = peak / pos.entry_price - 1;
  const age = now - pos.opened_at;
  if (pnl <= -cfg.STOP_LOSS_PCT) return { sell: true, reason: 'stop loss', peak };
  if (pnl >= cfg.TAKE_PROFIT_PCT) return { sell: true, reason: 'take profit', peak };
  if (peakGain >= cfg.TRAIL_ARM_PCT && price <= peak * (1 - cfg.TRAIL_PCT)) {
    return { sell: true, reason: 'trailing stop', peak };
  }
  if (cfg.STALE_MINUTES > 0 && age >= cfg.STALE_MINUTES * 60e3 && pnl < cfg.STALE_MIN_GAIN_PCT && peakGain < cfg.TRAIL_ARM_PCT) {
    return { sell: true, reason: 'no momentum', peak };
  }
  if (age >= cfg.MAX_HOLD_HOURS * 3600e3) return { sell: true, reason: 'max hold time', peak };
  return { sell: false, reason: null, peak };
}

export function positionSize(equity, cash, cfg) {
  const want = Math.min(equity * cfg.POSITION_PCT, cfg.MAX_TRADE_USD);
  const usd = Math.min(want, cash - cfg.CASH_RESERVE_USD);
  return usd >= cfg.MIN_TRADE_USD ? Math.floor(usd * 100) / 100 : 0;
}
