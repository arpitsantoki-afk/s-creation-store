-- Team roles + Google sign-in for admins, customer accounts, invoices.
ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'owner';      -- owner | manager | staff
ALTER TABLE admins ADD COLUMN status TEXT NOT NULL DEFAULT 'active';   -- active | invited | disabled
ALTER TABLE admins ADD COLUMN google_sub TEXT;
ALTER TABLE admins ADD COLUMN session_v INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS admins_google ON admins(google_sub);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  phone TEXT,
  company TEXT,
  tax_id TEXT,
  pass_hash TEXT,
  google_sub TEXT UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  addresses TEXT NOT NULL DEFAULT '[]',
  marketing INTEGER NOT NULL DEFAULT 0,
  session_v INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);

ALTER TABLE orders ADD COLUMN customer_id INTEGER;
ALTER TABLE orders ADD COLUMN invoice_no TEXT;
CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS orders_email ON orders(email);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
