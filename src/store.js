// D1 persistence for positions, trades, equity history, events and settings.

export class Store {
  constructor(db) {
    this.db = db;
  }

  async get(k, def = null) {
    const row = await this.db.prepare('SELECT v FROM state WHERE k = ?').bind(k).first();
    return row ? JSON.parse(row.v) : def;
  }

  async set(k, v) {
    await this.db
      .prepare('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .bind(k, JSON.stringify(v))
      .run();
  }

  async log(level, msg) {
    await this.db.prepare('INSERT INTO events (ts, level, msg) VALUES (?, ?, ?)').bind(Date.now(), level, msg).run();
  }

  async positions(mode) {
    const r = await this.db.prepare('SELECT * FROM positions WHERE mode = ? ORDER BY opened_at').bind(mode).all();
    return r.results || [];
  }

  async position(mode, mint) {
    return this.db.prepare('SELECT * FROM positions WHERE mode = ? AND mint = ?').bind(mode, mint).first();
  }

  async openPosition(p) {
    await this.db
      .prepare(
        `INSERT INTO positions (mode, mint, symbol, decimals, qty_raw, cost_usd, entry_price, peak_price, last_price, opened_at, buy_sig)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(p.mode, p.mint, p.symbol, p.decimals, p.qty_raw, p.cost_usd, p.entry_price, p.entry_price, p.entry_price, p.opened_at, p.buy_sig ?? null)
      .run();
  }

  async updatePrice(mode, mint, last, peak) {
    await this.db
      .prepare('UPDATE positions SET last_price = ?, peak_price = ? WHERE mode = ? AND mint = ?')
      .bind(last, peak, mode, mint)
      .run();
  }

  async closePosition(mode, mint) {
    await this.db.prepare('DELETE FROM positions WHERE mode = ? AND mint = ?').bind(mode, mint).run();
  }

  async addTrade(t) {
    await this.db
      .prepare(
        `INSERT INTO trades (ts, mode, side, mint, symbol, usd, qty_raw, price, pnl_usd, reason, sig)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(Date.now(), t.mode, t.side, t.mint, t.symbol, t.usd, t.qty_raw, t.price, t.pnl_usd ?? null, t.reason ?? null, t.sig ?? null)
      .run();
  }

  async trades(mode, limit = 50) {
    const r = await this.db.prepare('SELECT * FROM trades WHERE mode = ? ORDER BY id DESC LIMIT ?').bind(mode, limit).all();
    return r.results || [];
  }

  async realizedSince(mode, since) {
    const row = await this.db
      .prepare("SELECT COALESCE(SUM(pnl_usd), 0) AS pnl FROM trades WHERE mode = ? AND side = 'sell' AND ts >= ?")
      .bind(mode, since)
      .first();
    return row?.pnl || 0;
  }

  /** The most recent `n` closed trades (newest first). */
  async recentSells(mode, n) {
    const r = await this.db
      .prepare("SELECT ts, pnl_usd FROM trades WHERE mode = ? AND side = 'sell' ORDER BY id DESC LIMIT ?")
      .bind(mode, n)
      .all();
    return r.results || [];
  }

  async stats(mode) {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS sells,
                COALESCE(SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END), 0) AS wins,
                COALESCE(SUM(pnl_usd), 0) AS realized,
                COALESCE(SUM(CASE WHEN pnl_usd > 0 THEN pnl_usd ELSE 0 END), 0) AS gross_win,
                COALESCE(SUM(CASE WHEN pnl_usd < 0 THEN -pnl_usd ELSE 0 END), 0) AS gross_loss
         FROM trades WHERE mode = ? AND side = 'sell'`,
      )
      .bind(mode)
      .first();
  }

  async recordEquity(mode, equity) {
    const now = Date.now();
    await this.db.prepare('INSERT INTO equity (ts, mode, equity) VALUES (?, ?, ?)').bind(now, mode, equity).run();
    await this.db.prepare('DELETE FROM equity WHERE ts < ?').bind(now - 30 * 86400e3).run();
    await this.db.prepare('DELETE FROM events WHERE ts < ?').bind(now - 7 * 86400e3).run();
  }

  async equityHistory(mode, since) {
    const r = await this.db.prepare('SELECT ts, equity FROM equity WHERE mode = ? AND ts >= ? ORDER BY ts').bind(mode, since).all();
    return r.results || [];
  }

  async events(limit = 40) {
    const r = await this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').bind(limit).all();
    return r.results || [];
  }

  async cooldownActive(mode, mint, now = Date.now()) {
    const row = await this.db.prepare('SELECT until FROM cooldowns WHERE mode = ? AND mint = ?').bind(mode, mint).first();
    return !!row && row.until > now;
  }

  async setCooldown(mode, mint, until) {
    await this.db
      .prepare('INSERT INTO cooldowns (mode, mint, until) VALUES (?, ?, ?) ON CONFLICT(mode, mint) DO UPDATE SET until = excluded.until')
      .bind(mode, mint, until)
      .run();
  }

  async resetPaper() {
    await this.db.batch([
      this.db.prepare("DELETE FROM positions WHERE mode = 'paper'"),
      this.db.prepare("DELETE FROM trades WHERE mode = 'paper'"),
      this.db.prepare("DELETE FROM equity WHERE mode = 'paper'"),
      this.db.prepare("DELETE FROM cooldowns WHERE mode = 'paper'"),
      this.db.prepare(
        "DELETE FROM state WHERE k LIKE 'paper_%' OR k LIKE 'day_start_paper_%' OR k = 'v2_learning_paper' OR k LIKE 'v2_strategy_%' AND k NOT LIKE 'v2_strategy_live_%' OR k = 'last_equity_ts_paper'",
      ),
    ]);
  }
}
