# Sparkle Wash — Vehicle Washing Service

A simple cashier and queue system for a car and motorcycle wash, with a public website.

- **Public website** (`/`): hero section, services, a price table generated from the database, how it works, and a **live status check** where customers enter their plate number (`/status`).
- **Staff workspace** (`/app`), for cashiers and admins:
  - **Dashboard**: today's revenue, vehicles washed, the current queue, and unpaid totals.
  - **New wash**: type the plate. A returning vehicle's details fill in automatically. Pick the vehicle type, package and add-ons, and the total is calculated on the spot. Optionally mark it paid and print a receipt.
  - **Queue board**: Waiting → Washing → Done, with a payment button on each ticket. The board refreshes automatically.
  - **Transactions**: search and filter by date, status or payment. The detail page shows a printable receipt.
  - **Vehicles**: every plate, with its owner, number of visits and total spent.
  - **Reports**: monthly revenue by day, by package, by vehicle type and by payment method.
  - **Price list** (admin only): a price grid of package × vehicle type, plus managing vehicle types, packages and add-ons.
  - **Staff** (admin only): create cashier or admin accounts, reset passwords, disable accounts.

## Tech

- Node.js ≥ 22.13, Express 5, EJS templates
- SQLite through Node's built-in `node:sqlite`, so there is no native module to compile
- Plain CSS: the Poppins font and the palette **Vanilla Custard `#FEEFB6`**, **Pale Sky `#C3DAE8`** and **Deep Mocha `#432F2E`**

## Run it

```bash
npm install
npm run seed   # optional: adds ~6 weeks of demo transactions
npm start      # http://localhost:3000
```

Default login: **admin / admin123**. Change this password on the Staff page right away.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/washing.db` | SQLite file location |
| `TZ` | `Asia/Jakarta` | Timezone used for timestamps and "today" |
| `SESSION_SECRET` | random at startup | Set this so logins survive a restart |
| `BUSINESS_NAME` | `Sparkle Wash` | Name shown on the site and receipts |

## Project layout

```
server.js            entry point
src/db.js            schema, default price list, admin account
src/services.js      pricing, transactions, queue, reports
src/app.js           routes (public, staff, admin)
src/auth.js          password hashing, login guards
src/seed.js          demo data
views/               EJS pages (landing, status, login, app/*)
public/css/style.css design system
public/js/app.js     live price calculation, plate lookup, queue auto-refresh
```

## Data model

`vehicle_types`, `packages`, `package_prices` (package × type), `addons`, `customers`, `vehicles` (the plate is the unique key), `transactions`, `transaction_addons`, `users`.

Transactions copy the package name and price at the moment of sale, so later price changes never alter old receipts.
