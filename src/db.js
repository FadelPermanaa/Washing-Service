const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'washing.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'cashier')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicle_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS package_prices (
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  vehicle_type_id INTEGER NOT NULL REFERENCES vehicle_types(id) ON DELETE CASCADE,
  price INTEGER NOT NULL CHECK (price >= 0),
  PRIMARY KEY (package_id, vehicle_type_id)
);

CREATE TABLE IF NOT EXISTS addons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  price INTEGER NOT NULL CHECK (price >= 0),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate TEXT NOT NULL UNIQUE,
  vehicle_type_id INTEGER NOT NULL REFERENCES vehicle_types(id),
  brand_model TEXT,
  color TEXT,
  customer_id INTEGER REFERENCES customers(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  customer_id INTEGER REFERENCES customers(id),
  vehicle_type_id INTEGER NOT NULL REFERENCES vehicle_types(id),
  vehicle_type_name TEXT NOT NULL,
  package_id INTEGER NOT NULL REFERENCES packages(id),
  package_name TEXT NOT NULL,
  package_price INTEGER NOT NULL,
  addons_total INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'washing', 'done', 'cancelled')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
  payment_method TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS transaction_addons (
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  addon_id INTEGER REFERENCES addons(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_vehicle ON transactions(vehicle_id);
`);

/** Local timestamp "YYYY-MM-DD HH:MM:SS" in the process timezone (TZ). */
function now(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function today() {
  return now().slice(0, 10);
}

let txDepth = 0;

/** Run fn atomically. Nested calls use savepoints. */
function tx(fn) {
  const sp = `sp_${txDepth}`;
  db.exec(txDepth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    db.exec(txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    txDepth--;
    db.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  }
}

/** Insert default price list + admin account on an empty database. */
function seedDefaults() {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (!hasUsers) {
    db.prepare('INSERT INTO users (name, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('Administrator', 'admin', hashPassword('admin123'), 'admin', now());
  }

  const hasTypes = db.prepare('SELECT COUNT(*) AS n FROM vehicle_types').get().n > 0;
  if (hasTypes) return;

  tx(() => {
    const types = ['Motorcycle', 'City Car', 'Sedan / MPV', 'SUV', 'Large SUV / Pickup'];
    const typeIds = types.map((name, i) =>
      Number(db.prepare('INSERT INTO vehicle_types (name, sort_order) VALUES (?, ?)').run(name, i).lastInsertRowid));

    const pkgs = [
      ['Exterior Wash', 'Body, wheels & glass with snow foam', [15000, 35000, 40000, 45000, 55000]],
      ['Full Wash', 'Exterior + vacuum, dashboard wipe & inside glass', [25000, 50000, 60000, 70000, 85000]],
      ['Premium Wash + Wax', 'Full wash + body wax & tire shine', [40000, 85000, 100000, 120000, 140000]],
      ['Interior Detailing', 'Deep interior clean with extractor & steam', [null, 350000, 400000, 475000, 550000]],
    ];
    pkgs.forEach(([name, desc, prices], i) => {
      const pid = Number(db.prepare('INSERT INTO packages (name, description, sort_order) VALUES (?, ?, ?)').run(name, desc, i).lastInsertRowid);
      prices.forEach((price, j) => {
        if (price != null) {
          db.prepare('INSERT INTO package_prices (package_id, vehicle_type_id, price) VALUES (?, ?, ?)').run(pid, typeIds[j], price);
        }
      });
    });

    [['Tire Shine', 10000], ['Engine Bay Wash', 35000], ['Underbody Wash', 30000], ['Cabin Fragrance', 10000], ['Body Wax', 40000]]
      .forEach(([name, price]) => db.prepare('INSERT INTO addons (name, price) VALUES (?, ?)').run(name, price));
  });
}

seedDefaults();

module.exports = { db, now, today, tx };
