// Versioned schema migrations. The applied version is stored in SQLite's `PRAGMA user_version`.
// Append new migrations to the end of the list; never edit one that has shipped.
const { db, tx, hasColumn } = require('./db');
const { DEFAULT_ID_NAMES, DEFAULT_CHECKLISTS, DEFAULT_DURATIONS } = require('./defaults');

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

  // 3 — washers, bays, per-package checklists, commission.
  () => {
    // SQLite can't change a CHECK constraint in place, so rebuild `users` to allow the washer role.
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'cashier', 'washer')),
        phone TEXT,
        commission_type TEXT NOT NULL DEFAULT 'fixed' CHECK (commission_type IN ('fixed', 'percent')),
        commission_value INTEGER NOT NULL DEFAULT 0 CHECK (commission_value >= 0),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      INSERT INTO users_new (id, name, username, password_hash, role, active, created_at)
        SELECT id, name, username, password_hash, role, active, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;

      CREATE TABLE bays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO bays (name, sort_order) VALUES ('Bay 1', 1), ('Bay 2', 2);

      CREATE TABLE checklist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        label_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      ALTER TABLE transactions ADD COLUMN washer_id INTEGER REFERENCES users(id);
      ALTER TABLE transactions ADD COLUMN bay_id INTEGER REFERENCES bays(id);
      ALTER TABLE transactions ADD COLUMN commission INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX idx_tx_washer ON transactions(washer_id);

      CREATE TABLE transaction_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        label_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        done_at TEXT,
        done_by INTEGER REFERENCES users(id)
      );
      CREATE INDEX idx_checks_tx ON transaction_checks(transaction_id);
    `);
    const insert = db.prepare('INSERT INTO checklist_items (package_id, label, label_id, sort_order) VALUES (?, ?, ?, ?)');
    for (const [pkgName, items] of Object.entries(DEFAULT_CHECKLISTS)) {
      const pkg = db.prepare('SELECT id FROM packages WHERE name = ?').get(pkgName);
      if (pkg) items.forEach(([en, idLabel], i) => insert.run(pkg.id, en, idLabel, i));
    }
  },

  // 4 — settings, online bookings, private tracking links.
  () => {
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

      ALTER TABLE packages ADD COLUMN duration_min INTEGER NOT NULL DEFAULT 30;

      CREATE TABLE bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        token TEXT NOT NULL UNIQUE,
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        plate TEXT NOT NULL,
        vehicle_type_id INTEGER NOT NULL REFERENCES vehicle_types(id),
        package_id INTEGER NOT NULL REFERENCES packages(id),
        addon_ids TEXT NOT NULL DEFAULT '[]',
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        price_estimate INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'checked_in', 'no_show', 'cancelled')),
        notes TEXT,
        lang TEXT NOT NULL DEFAULT 'id',
        source TEXT NOT NULL DEFAULT 'online',
        transaction_id INTEGER REFERENCES transactions(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_bookings_date ON bookings(date, status);

      ALTER TABLE transactions ADD COLUMN token TEXT;
      ALTER TABLE transactions ADD COLUMN booking_id INTEGER REFERENCES bookings(id);
      UPDATE transactions SET token = lower(hex(randomblob(12))) WHERE token IS NULL;
      CREATE UNIQUE INDEX idx_tx_token ON transactions(token);
    `);
    for (const [name, minutes] of Object.entries(DEFAULT_DURATIONS)) {
      db.prepare('UPDATE packages SET duration_min = ? WHERE name = ?').run(minutes, name);
    }
  },

  // 5 — WhatsApp message outbox.
  () => db.exec(`
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      transaction_id INTEGER REFERENCES transactions(id),
      booking_id INTEGER REFERENCES bookings(id),
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'manual', 'done')),
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      handled_by INTEGER REFERENCES users(id)
    );
    CREATE UNIQUE INDEX idx_notif_once_tx ON notifications(kind, transaction_id) WHERE transaction_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_notif_once_booking ON notifications(kind, booking_id) WHERE booking_id IS NOT NULL;
    CREATE INDEX idx_notif_status ON notifications(status);
  `),

  // 6 — payments (split / partial), promo codes, stamp card, prepaid memberships.
  () => {
    db.exec(`
      CREATE TABLE promos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT,
        type TEXT NOT NULL CHECK (type IN ('percent', 'fixed')),
        value INTEGER NOT NULL CHECK (value > 0),
        min_spend INTEGER NOT NULL DEFAULT 0,
        starts_on TEXT,
        ends_on TEXT,
        max_uses INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE membership_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        name_id TEXT,
        package_id INTEGER NOT NULL REFERENCES packages(id),
        vehicle_type_id INTEGER REFERENCES vehicle_types(id),
        washes INTEGER NOT NULL CHECK (washes > 0),
        valid_days INTEGER NOT NULL CHECK (valid_days > 0),
        price INTEGER NOT NULL CHECK (price >= 0),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE memberships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL REFERENCES membership_plans(id),
        vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
        washes_total INTEGER NOT NULL,
        washes_left INTEGER NOT NULL CHECK (washes_left >= 0),
        starts_on TEXT NOT NULL,
        expires_on TEXT NOT NULL,
        price INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
        created_at TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id)
      );
      CREATE INDEX idx_memberships_vehicle ON memberships(vehicle_id, status);

      CREATE TABLE payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER REFERENCES transactions(id),
        membership_id INTEGER REFERENCES memberships(id),
        amount INTEGER NOT NULL CHECK (amount > 0),
        method TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id),
        CHECK ((transaction_id IS NULL) != (membership_id IS NULL))
      );
      CREATE INDEX idx_payments_tx ON payments(transaction_id);
      CREATE INDEX idx_payments_created ON payments(created_at);

      ALTER TABLE transactions ADD COLUMN promo_id INTEGER REFERENCES promos(id);
      ALTER TABLE transactions ADD COLUMN promo_code TEXT;
      ALTER TABLE transactions ADD COLUMN promo_discount INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE transactions ADD COLUMN free_discount INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE transactions ADD COLUMN membership_id INTEGER REFERENCES memberships(id);
      ALTER TABLE transactions ADD COLUMN membership_discount INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE transactions ADD COLUMN stamp_earned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE transactions ADD COLUMN stamps_used INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE vehicles ADD COLUMN stamps INTEGER NOT NULL DEFAULT 0;
    `);
    // Every earlier "paid" transaction becomes one payment of the full amount.
    db.exec(`INSERT INTO payments (transaction_id, amount, method, created_at, created_by)
      SELECT id, total, COALESCE(payment_method, 'Cash'), COALESCE(paid_at, created_at), created_by
      FROM transactions WHERE payment_status = 'paid' AND total > 0`);
  },

  // 7 — before/after photos, supplies & stock, expenses.
  () => db.exec(`
    CREATE TABLE transaction_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('before', 'after')),
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id)
    );
    CREATE INDEX idx_photos_tx ON transaction_photos(transaction_id);

    CREATE TABLE expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('supplies', 'utilities', 'salary', 'rent', 'equipment', 'marketing', 'other')),
      amount INTEGER NOT NULL CHECK (amount > 0),
      note TEXT,
      created_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id)
    );
    CREATE INDEX idx_expenses_date ON expenses(date);

    CREATE TABLE supplies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      name_id TEXT,
      unit TEXT NOT NULL DEFAULT 'pcs',
      stock REAL NOT NULL DEFAULT 0,
      min_stock REAL NOT NULL DEFAULT 0,
      usage_per_wash REAL NOT NULL DEFAULT 0,
      usage_package_id INTEGER REFERENCES packages(id),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE stock_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supply_id INTEGER NOT NULL REFERENCES supplies(id),
      qty REAL NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('purchase', 'usage', 'wash', 'adjust')),
      note TEXT,
      transaction_id INTEGER REFERENCES transactions(id),
      expense_id INTEGER REFERENCES expenses(id),
      created_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id)
    );
    CREATE INDEX idx_moves_supply ON stock_moves(supply_id, id);
  `),

  // 8 — activity log: who changed prices, cancelled washes, gave discounts, etc.
  () => db.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity TEXT,
      entity_id INTEGER,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_audit_created ON audit_log(created_at);
    CREATE INDEX idx_audit_user ON audit_log(user_id);
  `),
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
