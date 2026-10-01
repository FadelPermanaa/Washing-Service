// Fills the database with ~6 weeks of demo transactions so the dashboard and reports have something to show.
// Usage: npm run seed
process.env.TZ = process.env.TZ || 'Asia/Jakarta';
const { db, now, tx } = require('./db');
const svc = require('./services');

const count = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
if (count > 0 && !process.argv.includes('--force')) {
  console.log(`Database already has ${count} transactions. Run with --force to add more demo data.`);
  process.exit(0);
}

const { types, packages, addons, prices } = svc.getPriceList();
const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
const { hashPassword } = require('./auth');
if (!db.prepare("SELECT 1 FROM users WHERE role = 'washer'").get()) {
  [['Joko Susilo', 'joko', 'fixed', 8000], ['Rina Wati', 'rina', 'fixed', 8000], ['Dimas Pratama', 'dimas', 'percent', 10]].forEach(([name, username, type, value]) => {
    db.prepare(`INSERT INTO users (name, username, password_hash, role, commission_type, commission_value, created_at)
      VALUES (?, ?, ?, 'washer', ?, ?, ?)`).run(name, username, hashPassword('washer123'), type, value, now());
  });
}
const washers = db.prepare("SELECT * FROM users WHERE role = 'washer' AND active = 1").all();
const bays = db.prepare('SELECT id FROM bays WHERE active = 1').all();
const names = ['Budi Santoso', 'Siti Rahma', 'Andi Wijaya', 'Dewi Lestari', 'Rizky Pratama', 'Putri Anggraini', 'Agus Salim', 'Maya Sari', null, null];
const models = { Motorcycle: ['Honda Vario', 'Yamaha NMAX', 'Honda Beat'], default: ['Toyota Avanza', 'Honda Brio', 'Mitsubishi Xpander', 'Toyota Fortuner', 'Suzuki Ertiga', 'Honda HR-V'] };
const regions = ['B', 'D', 'F', 'AB', 'L', 'N'];
const methods = svc.PAYMENT_METHODS;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const letters = () => Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

// A pool of regular vehicles so some plates come back repeatedly.
const pool = Array.from({ length: 40 }, () => {
  const type = pick(types);
  return { plate: `${pick(regions)} ${1000 + Math.floor(Math.random() * 8999)} ${letters()}`, type, model: pick(models[type.name] || models.default), customer: pick(names) };
});

let created = 0;
tx(() => {
  for (let back = 42; back >= 0; back--) {
    const perDay = back === 0 ? 5 : 6 + Math.floor(Math.random() * 14);
    for (let i = 0; i < perDay; i++) {
      const v = pick(pool);
      const pkgs = packages.filter((p) => prices[`${p.id}:${v.type.id}`] != null);
      const pkg = Math.random() < 0.5 ? pkgs[0] : pick(pkgs);
      const chosenAddons = addons.filter(() => Math.random() < 0.15).map((a) => a.id);
      const id = svc.createTransaction({
        plate: v.plate, vehicle_type_id: v.type.id, package_id: pkg.id, addon_ids: chosenAddons,
        customer_name: v.customer || '', brand_model: v.model,
        pay_now: back === 0 && i >= 3 ? '' : '1', payment_method: pick(methods),
      }, admin.id);

      const d = new Date();
      d.setDate(d.getDate() - back);
      d.setHours(8 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 60), 0, 0);
      if (back === 0 && d > new Date()) d.setTime(Date.now() - (perDay - i) * 20 * 60 * 1000);
      const start = new Date(d.getTime() + 10 * 60 * 1000);
      const end = new Date(start.getTime() + (20 + Math.floor(Math.random() * 30)) * 60 * 1000);
      let status = 'done';
      if (back === 0) status = ['done', 'done', 'washing', 'waiting', 'waiting'][i] || 'waiting';
      const washer = status === 'waiting' ? null : pick(washers);
      const bay = status === 'washing' ? bays[i % bays.length] : (status === 'done' ? pick(bays) : null);
      const total = db.prepare('SELECT total FROM transactions WHERE id = ?').get(id).total;
      db.prepare(`UPDATE transactions SET created_at = ?, started_at = ?, finished_at = ?, status = ?, washer_id = ?, bay_id = ?, commission = ?,
          paid_at = CASE WHEN payment_status = 'paid' THEN ? END WHERE id = ?`)
        .run(now(d), status === 'waiting' ? null : now(start), status === 'done' ? now(end) : null, status,
          washer?.id ?? null, bay?.id ?? null, status === 'done' ? svc.commissionFor(washer, total) : 0, now(end), id);
      db.prepare('UPDATE payments SET created_at = ? WHERE transaction_id = ?').run(now(back === 0 ? start : end), id);
      if (status === 'washing') {
        const items = svc.packageChecklist(pkg.id);
        items.forEach((it, k) => db.prepare('INSERT INTO transaction_checks (transaction_id, label, label_id, sort_order, done_at, done_by) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, it.label, it.label_id, it.sort_order, k < items.length / 2 ? now(start) : null, k < items.length / 2 ? washer.id : null));
      }
      created++;
    }
  }
  // Re-number ticket codes so they match their (back-dated) creation day.
  const rows = db.prepare('SELECT id, created_at FROM transactions ORDER BY created_at, id').all();
  const seq = {};
  db.prepare("UPDATE transactions SET code = 'TMP-' || id").run();
  for (const r of rows) {
    const day = r.created_at.slice(2, 10).replace(/-/g, '');
    seq[day] = (seq[day] || 0) + 1;
    db.prepare('UPDATE transactions SET code = ? WHERE id = ?').run(`WSH-${day}-${String(seq[day]).padStart(3, '0')}`, r.id);
  }
});

// Promo code, a membership plan and a few memberships.
try { svc.createPromo({ code: 'HEMAT20', type: 'percent', value: 20, description: 'Diskon 20% pelanggan baru' }); } catch { /* exists */ }
if (!db.prepare('SELECT 1 FROM membership_plans').get()) {
  const full = packages.find((p) => p.name === 'Full Wash') || packages[0];
  svc.createPlan({ name: 'Full Wash 8x / month', name_id: 'Cuci Luar Dalam 8x / bulan', package_id: full.id, washes: 8, valid_days: 30, price: 340000 });
}
const plan = db.prepare('SELECT * FROM membership_plans ORDER BY id LIMIT 1').get();
pool.slice(0, 3).forEach((v) => {
  try { svc.sellMembership({ plate: v.plate, plan_id: plan.id, method: 'QRIS' }, admin.id); } catch { /* plan type mismatch */ }
});

// Supplies and a month of expenses.
if (!db.prepare('SELECT 1 FROM supplies').get()) {
  const det = packages.find((p) => p.name === 'Interior Detailing');
  [
    { name: 'Car shampoo', name_id: 'Sampo mobil', unit: 'liter', stock: 18, min_stock: 5, usage_per_wash: 0.2 },
    { name: 'Snow foam', name_id: 'Snow foam', unit: 'liter', stock: 3, min_stock: 4, usage_per_wash: 0.1 },
    { name: 'Body wax', name_id: 'Wax bodi', unit: 'kaleng', stock: 6, min_stock: 2, usage_per_wash: 0 },
    { name: 'Interior cleaner', name_id: 'Pembersih interior', unit: 'botol', stock: 8, min_stock: 2, usage_per_wash: 1, usage_package_id: det?.id },
    { name: 'Microfiber cloth', name_id: 'Lap microfiber', unit: 'pcs', stock: 40, min_stock: 10, usage_per_wash: 0 },
  ].forEach((sup) => svc.createSupply(sup, admin.id));
  const month = now().slice(0, 7);
  [['01', 'rent', 3500000, 'Sewa tempat'], ['03', 'utilities', 850000, 'Listrik'], ['03', 'utilities', 320000, 'Air PDAM'],
    ['05', 'supplies', 640000, 'Sampo & snow foam'], ['10', 'equipment', 450000, 'Servis mesin steam'], ['15', 'marketing', 300000, 'Iklan Instagram'],
    ['25', 'salary', 4800000, 'Gaji kasir & pencuci']].forEach(([d, category, amount, note]) => {
    const date = `${month}-${d}`;
    if (date <= now().slice(0, 10)) svc.addExpense({ date, category, amount, note }, admin.id);
  });
}

// A few online bookings for today and the next days.
let bookingsMade = 0;
for (const [offset, time, name, plate, pkgIdx] of [
  [0, '15:00', 'Budi Santoso', 'B 1122 KL', 1], [0, '16:30', 'Maya Sari', 'D 404 MS', 0],
  [1, '09:00', 'Rizky Pratama', 'F 88 RZ', 2], [1, '10:30', 'Dewi Lestari', 'B 2020 DL', 3], [2, '13:00', 'Agus Salim', 'AB 9 AS', 1],
]) {
  const date = svc.bookableDays()[offset];
  const pkg = packages[pkgIdx];
  const type = types.find((vt) => prices[`${pkg.id}:${vt.id}`] != null && vt.name !== 'Motorcycle') || types[1];
  try {
    svc.createBooking({ customer_name: name, phone: `0812${String(1000000 + bookingsMade * 7919).slice(0, 7)}`, plate, vehicle_type_id: type.id, package_id: pkg.id, date, time }, { lang: 'id' });
    bookingsMade++;
  } catch { /* slot not available (e.g. already passed today) */ }
}

console.log(`Created ${created} demo transactions and ${bookingsMade} bookings.`);
