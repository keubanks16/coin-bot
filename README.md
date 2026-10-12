# Phantom Alt Bot

An automated Solana altcoin trader that runs on Cloudflare Workers, trades through
Jupiter (the same swap engine Phantom uses), and uses your own Phantom wallet's key in live
mode. It starts in **paper mode**, which uses real Jupiter quotes and live prices but sends
no transactions.

Includes a phone-friendly dashboard with equity chart, open positions, trades and activity log,
plus Pause, Run now, Sell (one) and Sell all buttons.

---

## How it trades

Every minute, the bot checks open positions. Every 5 minutes, it scans Jupiter's top
trending and top traded tokens (1-hour window).

**Safety filter.** A token must pass all of these before it's considered:

- mint and freeze authority both disabled (the dev can't print more or freeze your tokens)
- not flagged suspicious by Jupiter, and top holders own ≤ 35%
- liquidity ≥ $200k, market cap ≥ $1M
- Jupiter-verified, or organic score ≥ 60 (real traders, not bots)
- first pool at least 48 hours old (skips fresh launches and rugs)

**Entry signal.** The bot looks for a steady climb, not a spike:

- up 3–25% over the last hour
- still rising over the last 5 minutes, but by less than 6%
- organic buy volume at least 1.15× organic sell volume, with more net buyers than sellers
- at least $50k of volume in the hour

The strongest candidates are bought first, up to 4 positions. Each position is 15% of
equity, capped at $250.

**Exits.** Each position is sold on whichever comes first:

- **Stop loss:** −8%
- **Take profit:** +25%
- **Trailing stop:** after +10%, sell if price drops 6% from its peak
- **Max hold:** 24 hours

**Guardrails:**

- No new buys after a −8% day (resets at midnight UTC).
- 6-hour cooldown before re-buying a token it just sold.
- Paper fills take an extra 0.5% haircut so paper results aren't rosier than live.

Every number is a setting in `wrangler.toml` (full list in `src/strategy.js`).

> **Be realistic.** No strategy reliably makes money on altcoins, and most momentum bots lose
> to fees, slippage and sudden dumps. Paper trade for at least 2 weeks, and only go live with
> money you can afford to lose entirely.

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
   password, and tap **Run now** to trigger the first scan. The cron runs every minute after
   that, so you can close the page.

Your Workers Paid plan easily covers the every-minute cron and D1 usage.

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
- `src/index.js`: cron handler and dashboard API
- `src/dashboard.html`: the dashboard
- `test/`: offline tests (`npm test`)

## Troubleshooting

- **"none passed filters" every scan.** This is normal in quiet markets; the filters are
  strict on purpose. To loosen them, lower `MIN_1H_CHANGE_PCT` or `MIN_LIQUIDITY_USD`.
- **"Low SOL for fees".** Send the bot wallet more SOL.
- **`order not buildable ... code 1`.** The wallet doesn't hold enough USDC.
- **Jupiter `401`/`403`.** Check `JUPITER_API_KEY`.
- **Logs.** Run `npx wrangler tail` to watch the bot in real time.
- 
