// Strategy: filtered momentum on established Solana altcoins.
//
// 1. Safety filter — skip anything that looks like a rug or a fresh launch.
// 2. Entry — steady 1h uptrend driven by real (organic) buyers, not a vertical spike.
// 3. Exit — stop loss, take profit, trailing stop once in profit, and a max hold time.
//
// Every number here can be overridden with a wrangler.toml [vars] entry of the same name.

import { USDC, SOL } from './jupiter.js';

const DEFAULTS = {
  PAPER_START_USD: 1000,
  POSITION_PCT: 0.15, // fraction of equity per new position
  MAX_POSITIONS: 4,
  MIN_TRADE_USD: 5,
  MAX_TRADE_USD: 250,
  CASH_RESERVE_USD: 2,
  STOP_LOSS_PCT: 0.08,
  TAKE_PROFIT_PCT: 0.25,
  TRAIL_ARM_PCT: 0.10, // trailing stop activates after this gain...
  TRAIL_PCT: 0.06, // ...and sells if price falls this far from the peak
  MAX_HOLD_HOURS: 24,
  DAILY_LOSS_LIMIT_PCT: 0.08, // stop opening trades for the day after this drawdown
  COOLDOWN_HOURS: 6, // don't re-buy a token this soon after selling it
  SCAN_EVERY_MIN: 5,
  MIN_LIQUIDITY_USD: 200000,
  MIN_MCAP_USD: 1000000,
  MIN_VOLUME_1H_USD: 50000,
  MIN_ORGANIC_SCORE: 60,
  MAX_TOP_HOLDERS_PCT: 35,
  MIN_TOKEN_AGE_HOURS: 48,
  MIN_1H_CHANGE_PCT: 3,
  MAX_1H_CHANGE_PCT: 25,
  MAX_5M_CHANGE_PCT: 6,
  MIN_ORGANIC_BUY_RATIO: 1.15, // organic buy volume / organic sell volume (1h)
  PAPER_SLIPPAGE_BPS: 50,
  SCALP_STOP_LOSS_PCT: 0.035,
  SCALP_TAKE_PROFIT_PCT: 0.06,
  SCALP_TRAIL_ARM_PCT: 0.035,
  SCALP_TRAIL_PCT: 0.025,
  SCALP_MAX_HOLD_HOURS: 1, // extra haircut on paper fills so paper isn't rosier than live
};

export function loadConfig(env = {}) {
  const cfg = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = env[k];
    cfg[k] = v === undefined || v === '' ? def : Number(v);
    if (Number.isNaN(cfg[k])) cfg[k] = def;
  }
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

/** Returns a positive score if the entry signal fires, otherwise null. */
export function entryScore(t, cfg) {
  const h = t.stats1h;
  const m = t.stats5m;
  if (!h || !m) return null;
  const ch1h = h.priceChange ?? 0;
  const ch5m = m.priceChange ?? 0;
  if (ch1h < cfg.MIN_1H_CHANGE_PCT || ch1h > cfg.MAX_1H_CHANGE_PCT) return null;
  if (ch5m < 0 || ch5m > cfg.MAX_5M_CHANGE_PCT) return null; // still rising, not spiking
  const vol = (h.buyVolume || 0) + (h.sellVolume || 0);
  if (vol < cfg.MIN_VOLUME_1H_USD) return null;
  const ratio = (h.buyOrganicVolume || 0) / Math.max(h.sellOrganicVolume || 0, 1);
  if (ratio < cfg.MIN_ORGANIC_BUY_RATIO) return null;
  if ((h.numNetBuyers || 0) <= 0) return null;
  const organic = (t.organicScore || 0) / 100;
  return ch1h * Math.min(ratio, 3) * (0.5 + organic);
}

/**
 * Decide whether to close a position at the current price.
 * Returns { sell: bool, reason, peak }.
 */
export function exitDecision(pos, price, cfg, now = Date.now(), strategy = 'momentum') {
  if (strategy === 'scalp') cfg = { ...cfg, STOP_LOSS_PCT: cfg.SCALP_STOP_LOSS_PCT, TAKE_PROFIT_PCT: cfg.SCALP_TAKE_PROFIT_PCT, TRAIL_ARM_PCT: cfg.SCALP_TRAIL_ARM_PCT, TRAIL_PCT: cfg.SCALP_TRAIL_PCT, MAX_HOLD_HOURS: cfg.SCALP_MAX_HOLD_HOURS };
  const peak = Math.max(pos.peak_price || pos.entry_price, price);
  const pnl = price / pos.entry_price - 1;
  const peakGain = peak / pos.entry_price - 1;
  if (pnl <= -cfg.STOP_LOSS_PCT) return { sell: true, reason: 'stop loss', peak };
  if (pnl >= cfg.TAKE_PROFIT_PCT) return { sell: true, reason: 'take profit', peak };
  if (peakGain >= cfg.TRAIL_ARM_PCT && price <= peak * (1 - cfg.TRAIL_PCT)) {
    return { sell: true, reason: 'trailing stop', peak };
  }
  if (now - pos.opened_at >= cfg.MAX_HOLD_HOURS * 3600e3) return { sell: true, reason: 'max hold time', peak };
  return { sell: false, reason: null, peak };
}

export function positionSize(equity, cash, cfg) {
  const want = Math.min(equity * cfg.POSITION_PCT, cfg.MAX_TRADE_USD);
  const usd = Math.min(want, cash - cfg.CASH_RESERVE_USD);
  return usd >= cfg.MIN_TRADE_USD ? Math.floor(usd * 100) / 100 : 0;
}
