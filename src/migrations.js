// Versioned schema migrations. The applied version is stored in SQLite's `PRAGMA user_version`.
// Append new migrations to the end of the list; never edit one that has shipped.
const { db, tx, hasColumn } = require('./db');
const { DEFAULT_ID_NAMES } = require('./defaults');

const migrations = [
  // 1 — base schema (the "simple" version). IF NOT EXISTS keeps it safe on databases created before versioning.
  () => db.exec(`
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
  `),

  // 2 — Indonesian names for catalog items and transaction snapshots.
  () => {
    const columns = [
      ['vehicle_types', 'name_id'], ['packages', 'name_id'], ['packages', 'description_id'], ['addons', 'name_id'],
      ['transactions', 'vehicle_type_name_id'], ['transactions', 'package_name_id'], ['transaction_addons', 'name_id'],
    ];
    for (const [table, col] of columns) {
      if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
    }
    for (const [en, idName] of Object.entries(DEFAULT_ID_NAMES.vehicle_types)) {
      db.prepare('UPDATE vehicle_types SET name_id = ? WHERE name = ? AND name_id IS NULL').run(idName, en);
    }
    for (const [en, [idName, idDesc]] of Object.entries(DEFAULT_ID_NAMES.packages)) {
      db.prepare('UPDATE packages SET name_id = ?, description_id = ? WHERE name = ? AND name_id IS NULL').run(idName, idDesc, en);
    }
    for (const [en, idName] of Object.entries(DEFAULT_ID_NAMES.addons)) {
      db.prepare('UPDATE addons SET name_id = ? WHERE name = ? AND name_id IS NULL').run(idName, en);
    }
    db.exec(`UPDATE transactions SET
      package_name_id = (SELECT name_id FROM packages p WHERE p.id = transactions.package_id AND p.name = transactions.package_name),
      vehicle_type_name_id = (SELECT name_id FROM vehicle_types v WHERE v.id = transactions.vehicle_type_id AND v.name = transactions.vehicle_type_name)
      WHERE package_name_id IS NULL`);
    db.exec(`UPDATE transaction_addons SET
      name_id = (SELECT name_id FROM addons a WHERE a.id = transaction_addons.addon_id AND a.name = transaction_addons.name)
      WHERE name_id IS NULL`);
  },
];

function currentVersion() {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function run() {
  // Foreign keys must be off while tables are rebuilt; db.js turns them back on afterwards.
  db.exec('PRAGMA foreign_keys = OFF;');
  let version = currentVersion();
  while (version < migrations.length) {
    const migration = migrations[version];
    tx(() => {
      migration();
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
    version++;
  }
  const problems = db.prepare('PRAGMA foreign_key_check').all();
  if (problems.length) throw new Error(`Foreign key check failed after migrations: ${JSON.stringify(problems.slice(0, 5))}`);
}

module.exports = { run, migrations, currentVersion };
