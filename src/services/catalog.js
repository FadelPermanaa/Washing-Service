const { db } = require('../db');
const { UserError, both, toInt } = require('./common');

function getPriceList({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  const types = db.prepare(`SELECT * FROM vehicle_types ${where} ORDER BY sort_order, id`).all();
  const packages = db.prepare(`SELECT * FROM packages ${where} ORDER BY sort_order, id`).all();
  const addons = db.prepare(`SELECT * FROM addons ${where} ORDER BY name`).all();
  const prices = {};
  for (const row of db.prepare('SELECT * FROM package_prices').all()) {
    prices[`${row.package_id}:${row.vehicle_type_id}`] = row.price;
  }
  return { types, packages, addons, prices };
}

/** Price of a package for a vehicle type, with its catalog rows. Throws a UserError when not offered. */
function packagePrice(vehicleTypeId, packageId) {
  const type = db.prepare('SELECT * FROM vehicle_types WHERE id = ? AND active = 1').get(vehicleTypeId);
  if (!type) throw new UserError('err.chooseType');
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(packageId);
  if (!pkg) throw new UserError('err.choosePackage');
  const row = db.prepare('SELECT price FROM package_prices WHERE package_id = ? AND vehicle_type_id = ?').get(pkg.id, type.id);
  if (!row) throw new UserError('err.packageUnavailable', { pkg: both(pkg), type: both(type) });
  return { type, pkg, price: row.price };
}

function activeAddons(addonIds = []) {
  const ids = [...new Set([].concat(addonIds).map((id) => toInt(id)).filter(Boolean))];
  return ids.map((id) => db.prepare('SELECT * FROM addons WHERE id = ? AND active = 1').get(id)).filter(Boolean);
}

module.exports = { getPriceList, packagePrice, activeAddons };
