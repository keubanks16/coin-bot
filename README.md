# Phantom Alt Bot

An automated Solana altcoin trader that runs on Cloudflare Workers, trades through
Jupiter (the same swap engine Phantom uses), and uses your own Phantom wallet's key in live
mode. It starts in **paper mode**, which uses real Jupiter quotes and live prices but sends
no transactions.

Includes a phone-friendly dashboard with equity chart, open positions, trades and activity log,
plus Pause, Run now, Sell (one) and Sell all buttons.

---

## Pump.fun sniper (`STRATEGY = "pump"`, the current setting)

**Paper only for now.** It won't trade real money in this mode even if `LIVE_TRADING` is on.

**Reading new coins.** The bot keeps one live connection to PumpPortal's free feed, which
announces every new pump.fun coin the moment it launches. Every 2 seconds it reads each young
coin's bonding curve straight from Solana, in one batched call, to see how much SOL people are
putting in.

**What it buys** ($20 each, up to 3 at once). A coin must be all of these:

- under 3 minutes old, and at least 10 seconds old (skips the bundled launch buys)
- at least 3 SOL of buying from other traders since launch (the creator's own buy doesn't count)
- still cheap: market cap under 90 SOL (coins launch at about 28 SOL)
- climbing right now: up at least 1% in the last ~4 seconds, and not already falling off its high
- creator bought no more than 10% of the supply, and hasn't sold half of it
- has a Twitter, Telegram or website link in its metadata

**When it sells** (whichever comes first):

- **Take profit:** as soon as the trade is up $5 after fees (`PUMP_TAKE_PROFIT_USD`; 0 turns it off)
- **First downturn:** once it's up 5%, the first 12% drop from its highest point
- **Stop loss:** −25%
- **Stalled:** nobody has bought for 45 seconds
- **Max hold:** 10 minutes, or the moment the coin graduates off the bonding curve

**Graduation exits:** once the curve is complete, paper positions and shadow trades wait for
a fresh Jupiter sell quote for the full holding into USDC. The simulator uses that quote
minus the 3% paper haircut, never the completed bonding curve. If migration is still pending
or no valid route exists, the position stays open and the bot retries; it credits no cash or
learning outcome. Open positions retain their last valuation while waiting (not a guaranteed
exit value). The pending graduation state survives restarts. These are simulated quote-based
fills, not confirmed transactions or a guarantee of live execution.

It never buys the same coin twice, and stops buying for the day after a −6% day.

**Learning from its mistakes.** Every coin that passes the filters becomes a lesson, whether the
bot buys it or not. Coins it can't or won't buy are followed as "shadow trades" with the same
exit rules, so it learns from far more outcomes than its real trades alone. For each lesson it
records the setup (age, SOL bought, buying speed, market cap, how fast it was climbing, creator
bag, social links, time of day) and the result after fees. It keeps a running average return
for each kind of setup, pulling small samples toward the overall average so a few lucky trades
can't fool it. After 30 lessons it only buys setups it expects to profit from, and logs why it
skips the others. Skipped coins are still followed, so it can change its mind. The dashboard's
"What it's learned" section shows which setups have worked best and worst.

**Which profit target works.** Every coin it follows is also scored against several
take-profit targets at once (+10%, +15%, +25%, +40%, +60% and none), following each coin until
its other exits fire. The dashboard shows what each target would have averaged per trade after
fees, so you can pick the target the data supports.

If nothing it sees is profitable after fees, it will learn that too and mostly stop buying.
That's the honest answer, not a bug.

**How paper results are kept honest.** Fills use the real on-chain curve, pump.fun's fee
(1.25% each way at low market caps), and an extra 3% haircut each way, because sniper bots
running next to the chain get in ahead of a 2-second poll. So every trade starts about 9% down,
and a coin has to really run for the bot to profit.

> **Be realistic.** Most pump.fun coins go to zero within minutes; well under 1% ever
> graduate, and only a few percent of pump.fun traders have made more than $1,000. Expect many
> small losses. Judge it on profit factor over 100+ trades before even thinking about real money.

**Tip:** set `SOLANA_RPC_URL` to a free Helius URL (https://helius.dev). The public Solana
endpoint may rate-limit a bot that reads the chain every 2 seconds.

---

## Scalp strategy (`STRATEGY = "scalp"`)

The bot scalps: it gets into a fresh short-term push, takes a small gain, and gets out fast.

**Speed.** A fast loop (a Durable Object alarm) re-prices open positions every **5 seconds**
and scans for new entries every **30 seconds**. The every-minute cron only keeps that loop
alive. These are tuned to the free Jupiter key's limit of 1 request/second; the bot spaces
its calls automatically. With a paid Jupiter key, raise `JUP_RPS` and lower the timers.

**Safety filter.** A token must pass all of these before it's considered:

- mint and freeze authority both disabled (the dev can't print more or freeze your tokens)
- not flagged suspicious by Jupiter, and top holders own ≤ 35%
- liquidity ≥ $300k, market cap ≥ $1M
- Jupiter-verified, or organic score ≥ 60 (real traders, not bots)
- first pool at least 48 hours old (skips fresh launches and rugs)

**Entry signal** (scans Jupiter's top trending and top traded tokens, 5-minute window):

- up 1.2–5% in the last 5 minutes (moving, not a vertical spike)
- up 2–20% over the hour (a real uptrend, not already exhausted)
- at least $40k traded in the last 5 minutes and $100k in the hour
- organic buy volume at least 1.25× organic sell volume, with more net buyers than sellers
- ranked higher when more of the pool is turning over (tighter, faster fills)

**Cost check.** Before every buy, the bot gets a real quote to buy *and* a quote to sell
straight back. If that round trip would lose more than **0.6%** (fees + price impact), or the
take profit isn't at least 3× that cost, it skips the token. Small scalps only work when the
cost of getting in and out is small.

Up to 4 positions at once. Each is 15% of equity, capped at $250.

**Exits.** Positions are valued at what they would really sell for right now (a live sell
quote after fees and price impact), not the display price. Each is sold on whichever comes first:

- **Stop loss:** −2.5%
- **Take profit:** +4%
- **Trailing stop:** after +1.5%, sell if price drops 1% from its peak
- **No momentum:** still under +0.5% after 15 minutes
- **Max hold:** 1 hour

**Guardrails:**

- No new buys after a −6% day (resets at midnight UTC).
- No new buys for an hour after 4 losing trades in a row.
- After a win, 30 minutes before re-buying that token; after a loss, 4 hours.
- Paper and live use exactly the same rules, so paper results are a fair preview.
- Paper fills take an extra 0.3% haircut so paper results aren't rosier than live.

Set `STRATEGY = "momentum"` to go back to the original slower 1-hour swing strategy.
Every number is a setting in `wrangler.toml` (full list in `src/strategy.js`).

The dashboard's win-rate card also shows **PF** (profit factor: total won ÷ total lost).
Above 1.0 means the strategy is making money after costs; below 1.0, it isn't.

> **Be realistic.** No strategy reliably makes money on altcoins, and most scalping bots lose
> to fees, slippage and sudden dumps. Paper trade for at least 2 weeks and 100+ trades, only
> go live if profit factor stays above about 1.2, and only with money you can afford to lose.

---

## Setup (Windows, about 15 minutes)

1. **Install Node.js LTS** from https://nodejs.org. Then open **Command Prompt** in this folder.
2. **Install dependencies:**
   ```
   npm install
   ```
3. **Log in to Cloudflare.** This opens your browser.
   ```
   npx wrangler login
   ```
4. **Create the database:**
   ```
   npx wrangler d1 create phantom-alt-bot
   ```
   Copy the `database_id` it prints into `wrangler.toml`, replacing `PASTE_DATABASE_ID_HERE`.
5. **Create the tables:**
   ```
   npm run db:init
   ```
6. **Get a free Jupiter API key** at https://developers.jup.ag/portal.
7. **Set secrets.** Each command prompts you to paste the value.
   ```
   npx wrangler secret put DASHBOARD_PASSWORD
   npx wrangler secret put JUPITER_API_KEY
   ```
8. **Deploy:**
   ```
   npm run deploy
   ```
   Open the `https://phantom-alt-bot.<you>.workers.dev` URL it prints, enter your dashboard
   password, and tap **Run now** to trigger the first scan. Within a minute the cron starts
   the 5-second loop, so you can close the page.

Your Workers Paid plan covers the fast loop (about 17,000 short Durable Object runs a day)
and the D1 usage.

---

## Going live (when paper results justify it)

1. **Create a separate bot wallet in Phantom.** Use Add/Connect Account → Create new account,
   so your main wallet's funds are never exposed to the bot.
2. **Fund the bot wallet.** Send it USDC (the amount you're willing to risk) plus about
   **0.05 SOL** for fees.
3. **Export the bot account's private key** in Phantom: Settings → Manage Accounts → (bot
   account) → Show Private Key. Menu names can vary slightly by app version. Never share this
   key or paste it anywhere else.
4. **Store the key as a secret:**
   ```
   npx wrangler secret put WALLET_PRIVATE_KEY
   ```
5. **Turn on live trading.** In `wrangler.toml`, set `LIVE_TRADING = "true"`. Consider
   lowering `MAX_TRADE_USD` for the first week.
6. **Deploy again:**
   ```
   npm run deploy
   ```

The dashboard badge turns red and reads **LIVE**. Trades link to Solscan.

Paper and live keep separate positions and history. To go back to paper, set
`LIVE_TRADING = "false"` and redeploy. Any open live positions stay in your wallet, so close
them first with **Sell all**.

Optionally, set `SOLANA_RPC_URL` to a free Helius or QuickNode URL. It's more reliable than
the public endpoint for balance checks.

---

## Controls

| Button | What it does |
|---|---|
| Run now | Runs a cycle and scans immediately |
| Pause / Resume | Stops new buys; open positions are still managed (stops still fire) |
| Sell | Closes one position now |
| Sell all | Closes everything and pauses |
| Reset paper account | Wipes paper history back to the starting balance |

## Files

- `src/strategy.js`: filters, entry signal, exits, sizing (the part to tune)
- `src/bot.js`: the trading cycle
- `src/jupiter.js`: Jupiter Swap v2 / Price v3 / Tokens v2 client
- `src/solana.js`: Phantom key loading and transaction signing (no dependencies)
- `src/index.js`: cron handler, fast loop (FastMonitor Durable Object) and dashboard API
- `src/dashboard.html`: the dashboard
- `test/`: offline tests (`npm test`)

## Troubleshooting

- **"none passed filters" every scan.** This is normal in quiet markets; the filters are
  strict on purpose. To loosen them, lower `MIN_5M_CHANGE_PCT`, `MIN_VOLUME_5M_USD` or
  `MIN_LIQUIDITY_USD`.
- **Lots of "Skip ...: round-trip cost too high".** Those tokens are too expensive to scalp at
  your trade size. That's the filter protecting you; don't raise `MAX_ROUNDTRIP_COST_PCT` much.
- **Jupiter `429`.** You're over your key's rate limit. Lower `JUP_RPS` or raise `TICK_SECONDS`.
- **"Low SOL for fees".** Send the bot wallet more SOL.
- **`order not buildable ... code 1`.** The wallet doesn't hold enough USDC.
- **Jupiter `401`/`403`.** Check `JUPITER_API_KEY`.
- **Logs.** Run `npx wrangler tail` to watch the bot in real time.


