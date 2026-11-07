-- Strážca cien – schéma D1
CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  input         TEXT NOT NULL,              -- čo používateľ zadal (URL alebo názov)
  kind          TEXT NOT NULL,              -- 'url' | 'query'
  market        TEXT NOT NULL DEFAULT 'sk', -- 'sk' | 'cz'
  track_url     TEXT,                       -- stránka, ktorú scraper reálne sleduje
  selector      TEXT,                       -- voliteľný vlastný CSS selektor ceny
  name          TEXT,
  image         TEXT,
  shop          TEXT,
  currency      TEXT,
  current_price REAL,
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'ok' | 'error'
  last_error    TEXT,
  error_count   INTEGER NOT NULL DEFAULT 0,
  last_checked  TEXT,
  created_at    TEXT NOT NULL
);

-- Ukladá sa prvá cena a potom každá zmena
CREATE TABLE IF NOT EXISTS prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price       REAL NOT NULL,
  currency    TEXT NOT NULL,
  checked_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prices_product ON prices(product_id, checked_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint    TEXT PRIMARY KEY,
  keys_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
