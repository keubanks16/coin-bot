import { runCycle, makeContext, sellPosition } from './bot.js';
import { loadConfig } from './strategy.js';
import { USDC, USDC_DECIMALS } from './jupiter.js';
import DASHBOARD_HTML from './dashboard.html';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function authorized(req, env) {
  const want = env.DASHBOARD_PASSWORD || '';
  const got = req.headers.get('x-dash-key') || '';
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

async function getState(env) {
  const ctx = await makeContext(env);
  const { store, cfg, mode } = ctx;
  const now = Date.now();
  const positions = await store.positions(mode);
  let cash;
  try {
    cash = cfg.LIVE
      ? Number(BigInt(await ctx.rpc.tokenBalanceRaw(ctx.wallet.publicKey, USDC))) / 10 ** USDC_DECIMALS
      : await store.get('paper_cash', cfg.PAPER_START_USD);
  } catch {
    cash = null;
  }
  const pos = positions.map((p) => {
    const qty = Number(BigInt(p.qty_raw)) / 10 ** p.decimals;
    const price = p.last_price || p.entry_price;
    const value = qty * price;
    return { mint: p.mint, symbol: p.symbol, cost: p.cost_usd, value, pnl: value - p.cost_usd, pnlPct: price / p.entry_price - 1, entry: p.entry_price, price, peak: p.peak_price, openedAt: p.opened_at };
  });
  const held = pos.reduce((s, p) => s + p.value, 0);
  const equity = cash === null ? null : cash + held;
  const dayStart = await store.get(`day_start_${mode}_${new Date(now).toISOString().slice(0, 10)}`);
  const history = await store.equityHistory(mode, now - 7 * 86400e3);
  const step = Math.max(1, Math.ceil(history.length / 300));
  const stats = await store.stats(mode);
  const start = cfg.LIVE ? await store.get('live_start_equity', null) : cfg.PAPER_START_USD;
  if (cfg.LIVE && start === null && equity) await store.set('live_start_equity', equity);
  return {
    mode,
    wallet: ctx.wallet?.publicKey || null,
    paused: await store.get('paused', false),
    cash,
    equity,
    startEquity: start ?? equity,
    dayChange: dayStart && equity ? equity / dayStart - 1 : 0,
    positions: pos,
    trades: await store.trades(mode, 50),
    events: await store.events(40),
    stats,
    lastScanNote: await store.get('last_scan_note', null),
    history: history.filter((_, i) => i % step === 0 || i === history.length - 1),
    rules: {
      stopLoss: cfg.STOP_LOSS_PCT,
      takeProfit: cfg.TAKE_PROFIT_PCT,
      trailArm: cfg.TRAIL_ARM_PCT,
      trail: cfg.TRAIL_PCT,
      maxPositions: cfg.MAX_POSITIONS,
      positionPct: cfg.POSITION_PCT,
      maxTrade: cfg.MAX_TRADE_USD,
      dailyLossLimit: cfg.DAILY_LOSS_LIMIT_PCT,
      maxHoldHours: cfg.MAX_HOLD_HOURS,
      strategy: cfg.STRATEGY,
      tickSeconds: env.FAST_MONITOR ? cfg.TICK_SECONDS : 60,
      scanSeconds: cfg.SCAN_EVERY_SEC,
      staleMinutes: cfg.STALE_MINUTES,
      maxRoundTripCost: cfg.MAX_ROUNDTRIP_COST_PCT,
    },
  };
}

async function handleApi(req, env, path) {
  if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
  const ctx = await makeContext(env);
  const { store } = ctx;

  if (req.method === 'GET' && path === '/api/state') return json(await getState(env));
  if (req.method !== 'POST') return json({ error: 'not found' }, 404);

  switch (path) {
    case '/api/pause':
      await store.set('paused', true);
      await store.log('info', 'Paused new buys (open positions are still managed)');
      return json({ ok: true });
    case '/api/resume':
      await store.set('paused', false);
      await store.log('info', 'Resumed');
      return json({ ok: true });
    case '/api/run':
      return json(await runCycle(env, { forceScan: true }));
    case '/api/sell': {
      const { mint } = await req.json();
      const pos = await store.position(ctx.mode, mint);
      if (!pos) return json({ error: 'no such position' }, 404);
      return json(await sellPosition(ctx, pos, 'manual'));
    }
    case '/api/sellall': {
      await store.set('paused', true);
      const results = [];
      for (const pos of await store.positions(ctx.mode)) results.push({ symbol: pos.symbol, ...(await sellPosition(ctx, pos, 'sell all')) });
      await store.log('warn', 'SELL ALL pressed — bot paused');
      return json({ results });
    }
    case '/api/reset-paper':
      if (ctx.cfg.LIVE) return json({ error: 'only in paper mode' }, 400);
      await store.resetPaper();
      await store.log('info', 'Paper account reset');
      return json({ ok: true });
    default:
      return json({ error: 'not found' }, 404);
  }
}

// Fast loop. Cron can only fire once a minute, so a Durable Object alarm re-runs the cycle
// every TICK_SECONDS (default 5s). The every-minute cron just makes sure the loop is alive.
export class FastMonitor {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // Called by older deployments' cron; same as a kick.
  async start() {
    return this.fetch();
  }

  async fetch() {
    const cur = await this.state.storage.getAlarm();
    // Restart the loop if it has no alarm or the alarm is badly overdue.
    if (!cur || cur < Date.now() - 30e3) await this.state.storage.setAlarm(Date.now() + 100);
    return new Response('ok');
  }

  async alarm() {
    const { TICK_SECONDS } = loadConfig(this.env);
    // Schedule the next tick first, so an error can never stop the loop.
    await this.state.storage.setAlarm(Date.now() + TICK_SECONDS * 1000);
    try {
      await runCycle(this.env);
    } catch {
      // already logged to the dashboard by runCycle
    }
  }
}

async function kickTicker(env) {
  const stub = env.FAST_MONITOR.get(env.FAST_MONITOR.idFromName('paper-monitor'));
  await stub.fetch('https://ticker/kick');
}

export default {
  async scheduled(_event, env, ctx) {
    if (env.FAST_MONITOR) ctx.waitUntil(kickTicker(env).catch(() => runCycle(env).catch(() => {})));
    else ctx.waitUntil(runCycle(env).catch(() => {}));
  },

  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    try {
      if (path.startsWith('/api/')) return await handleApi(req, env, path);
      if (path === '/' || path === '/index.html') {
        return new Response(DASHBOARD_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
