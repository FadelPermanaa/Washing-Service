// Default data for a brand-new database: an admin account and a starter price list (English + Indonesian names).

// Indonesian names for the default catalog (also used by migration 2 to back-fill older databases).
const DEFAULT_ID_NAMES = {
  vehicle_types: {
    Motorcycle: 'Motor',
    'City Car': 'Mobil Kecil (City Car)',
    'Sedan / MPV': 'Sedan / MPV',
    SUV: 'SUV',
    'Large SUV / Pickup': 'SUV Besar / Pick-up',
  },
  packages: {
    'Exterior Wash': ['Cuci Luar', 'Bodi, velg, dan kaca dengan snow foam'],
    'Full Wash': ['Cuci Luar Dalam', 'Cuci luar + vakum interior, lap dasbor, dan kaca dalam'],
    'Premium Wash + Wax': ['Cuci Premium + Wax', 'Cuci luar dalam + wax bodi dan semir ban'],
    'Interior Detailing': ['Detailing Interior', 'Pembersihan interior menyeluruh dengan extractor dan steam'],
  },
  addons: {
    'Tire Shine': 'Semir Ban',
    'Engine Bay Wash': 'Cuci Mesin',
    'Underbody Wash': 'Cuci Kolong',
    'Cabin Fragrance': 'Pewangi Kabin',
    'Body Wax': 'Wax Bodi',
  },
};

const DEFAULT_PACKAGES = [
  ['Exterior Wash', 'Body, wheels & glass with snow foam', [15000, 35000, 40000, 45000, 55000]],
  ['Full Wash', 'Exterior + vacuum, dashboard wipe & inside glass', [25000, 50000, 60000, 70000, 85000]],
  ['Premium Wash + Wax', 'Full wash + body wax & tire shine', [40000, 85000, 100000, 120000, 140000]],
  ['Interior Detailing', 'Deep interior clean with extractor & steam', [null, 350000, 400000, 475000, 550000]],
];

// Default step-by-step checklist per package: [English, Indonesian].
const EXTERIOR_STEPS = [
  ['Pre-rinse body and wheels', 'Bilas awal bodi dan velg'],
  ['Apply snow foam', 'Semprot snow foam'],
  ['Clean wheels and tires', 'Bersihkan velg dan ban'],
  ['Rinse off foam', 'Bilas busa sampai bersih'],
  ['Dry with microfiber', 'Keringkan dengan lap microfiber'],
  ['Clean outside glass', 'Bersihkan kaca luar'],
];
const INTERIOR_STEPS = [
  ['Vacuum seats and carpets', 'Vakum jok dan karpet'],
  ['Wipe dashboard and panels', 'Lap dasbor dan panel'],
  ['Clean inside glass', 'Bersihkan kaca dalam'],
];
const DEFAULT_CHECKLISTS = {
  'Exterior Wash': EXTERIOR_STEPS,
  'Full Wash': [...EXTERIOR_STEPS, ...INTERIOR_STEPS],
  'Premium Wash + Wax': [...EXTERIOR_STEPS, ...INTERIOR_STEPS, ['Apply body wax', 'Aplikasikan wax bodi'], ['Tire shine', 'Semir ban']],
  'Interior Detailing': [
    ['Remove loose items and floor mats', 'Keluarkan barang dan karpet dasar'],
    ['Vacuum the whole cabin', 'Vakum seluruh kabin'],
    ['Extractor on seats and carpets', 'Extractor pada jok dan karpet'],
    ['Steam clean panels and vents', 'Steam panel dan kisi AC'],
    ['Clean inside glass', 'Bersihkan kaca dalam'],
    ['Final inspection', 'Pemeriksaan akhir'],
  ],
};

const DEFAULT_ADDONS = [['Tire Shine', 10000], ['Engine Bay Wash', 35000], ['Underbody Wash', 30000], ['Cabin Fragrance', 10000], ['Body Wax', 40000]];

function seed() {
  const { db, now, tx } = require('./db');
  const { hashPassword } = require('./auth');

  if (!db.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
    db.prepare('INSERT INTO users (name, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('Administrator', 'admin', hashPassword('admin123'), 'admin', now());
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM vehicle_types').get().n) return;

  tx(() => {
    const typeIds = Object.entries(DEFAULT_ID_NAMES.vehicle_types).map(([name, nameId], i) =>
      Number(db.prepare('INSERT INTO vehicle_types (name, name_id, sort_order) VALUES (?, ?, ?)').run(name, nameId, i).lastInsertRowid));

    DEFAULT_PACKAGES.forEach(([name, desc, prices], i) => {
      const [nameId, descId] = DEFAULT_ID_NAMES.packages[name];
      const pid = Number(db.prepare('INSERT INTO packages (name, name_id, description, description_id, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(name, nameId, desc, descId, i).lastInsertRowid);
      prices.forEach((price, j) => {
        if (price != null) db.prepare('INSERT INTO package_prices (package_id, vehicle_type_id, price) VALUES (?, ?, ?)').run(pid, typeIds[j], price);
      });
      (DEFAULT_CHECKLISTS[name] || []).forEach(([en, idLabel], k) => {
        db.prepare('INSERT INTO checklist_items (package_id, label, label_id, sort_order) VALUES (?, ?, ?, ?)').run(pid, en, idLabel, k);
      });
    });

    for (const [name, price] of DEFAULT_ADDONS) {
      db.prepare('INSERT INTO addons (name, name_id, price) VALUES (?, ?, ?)').run(name, DEFAULT_ID_NAMES.addons[name], price);
    }
  });
}

module.exports = { seed, DEFAULT_ID_NAMES, DEFAULT_CHECKLISTS };
