CREATE TABLE IF NOT EXISTS state (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS positions (
  mode TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  decimals INTEGER,
  qty_raw TEXT,
  cost_usd REAL,
  entry_price REAL,
  peak_price REAL,
  last_price REAL,
  opened_at INTEGER,
  buy_sig TEXT,
  PRIMARY KEY (mode, mint)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  mode TEXT,
  side TEXT,
  mint TEXT,
  symbol TEXT,
  usd REAL,
  qty_raw TEXT,
  price REAL,
  pnl_usd REAL,
  reason TEXT,
  sig TEXT
);
CREATE INDEX IF NOT EXISTS trades_mode_ts ON trades (mode, ts);

CREATE TABLE IF NOT EXISTS equity (
  ts INTEGER,
  mode TEXT,
  equity REAL
);
CREATE INDEX IF NOT EXISTS equity_mode_ts ON equity (mode, ts);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  level TEXT,
  msg TEXT
);

CREATE TABLE IF NOT EXISTS cooldowns (
  mode TEXT NOT NULL,
  mint TEXT NOT NULL,
  until INTEGER,
  PRIMARY KEY (mode, mint)
);
