// An older database (created by the first version, before migrations existed) must upgrade cleanly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

test('upgrades a database from the first release', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsh-mig-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'cashier')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL);
    CREATE TABLE vehicle_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE packages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE package_prices (package_id INTEGER NOT NULL, vehicle_type_id INTEGER NOT NULL, price INTEGER NOT NULL, PRIMARY KEY (package_id, vehicle_type_id));
    CREATE TABLE addons (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, price INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE vehicles (id INTEGER PRIMARY KEY AUTOINCREMENT, plate TEXT NOT NULL UNIQUE, vehicle_type_id INTEGER NOT NULL, brand_model TEXT, color TEXT, customer_id INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, vehicle_id INTEGER NOT NULL, customer_id INTEGER,
      vehicle_type_id INTEGER NOT NULL, vehicle_type_name TEXT NOT NULL, package_id INTEGER NOT NULL, package_name TEXT NOT NULL,
      package_price INTEGER NOT NULL, addons_total INTEGER NOT NULL DEFAULT 0, discount INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting', payment_status TEXT NOT NULL DEFAULT 'unpaid', payment_method TEXT, notes TEXT,
      created_by INTEGER, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, paid_at TEXT);
    CREATE TABLE transaction_addons (transaction_id INTEGER NOT NULL, addon_id INTEGER, name TEXT NOT NULL, price INTEGER NOT NULL);
    INSERT INTO users VALUES (1, 'Owner', 'owner', 'x:y', 'admin', 1, '2026-01-01 08:00:00');
    INSERT INTO vehicle_types VALUES (1, 'Motorcycle', 0, 1);
    INSERT INTO packages VALUES (1, 'Exterior Wash', 'Body', 0, 1);
    INSERT INTO package_prices VALUES (1, 1, 15000);
    INSERT INTO addons VALUES (1, 'Tire Shine', 10000, 1);
    INSERT INTO vehicles VALUES (1, 'B 1 A', 1, NULL, NULL, NULL, '2026-01-01 08:00:00');
    INSERT INTO transactions (id, code, vehicle_id, vehicle_type_id, vehicle_type_name, package_id, package_name, package_price, total, status, payment_status, payment_method, created_by, created_at, paid_at)
      VALUES (1, 'WSH-260101-001', 1, 1, 'Motorcycle', 1, 'Exterior Wash', 15000, 25000, 'done', 'paid', 'Cash', 1, '2026-01-01 08:00:00', '2026-01-01 08:30:00');
    INSERT INTO transaction_addons VALUES (1, 1, 'Tire Shine', 10000);
  `);
  old.close();

  process.env.DB_PATH = file;
  process.env.DATA_DIR = dir;
  const { db } = require('../src/db');
  const { migrations } = require('../src/migrations');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);
  const tx = db.prepare('SELECT package_name_id, vehicle_type_name_id FROM transactions WHERE id = 1').get();
  assert.equal(tx.package_name_id, 'Cuci Luar');
  assert.equal(tx.vehicle_type_name_id, 'Motor');
  assert.equal(db.prepare('SELECT name_id FROM transaction_addons').get().name_id, 'Semir Ban');
  // existing data is untouched
  assert.equal(db.prepare('SELECT total FROM transactions WHERE id = 1').get().total, 25000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});
