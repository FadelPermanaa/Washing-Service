# Sparkle Wash — Vehicle Washing Service

A management system for a car and motorcycle wash: cashier and queue, online booking, washers and checklists, WhatsApp messages, promos and memberships, photos, stock, expenses and reports. Bahasa Indonesia is the default language, with English available. Every screen works on laptop, tablet and phone.

## Who uses it

| Role | What they do |
|---|---|
| **Customer** (no login) | Books online, gets WhatsApp messages, follows the wash live through a private link, sees before/after photos |
| **Washer** | "My jobs" on a phone: checklist per car, before/after photos, finish the job, see their commission |
| **Cashier** | New washes, queue, payments, bookings, memberships, WhatsApp outbox, transactions, vehicles, reports |
| **Admin** | Everything a cashier does, plus prices, checklists, promo codes, membership plans, stock, expenses, profit, exports, staff, settings and the activity log |

## Features

**Counter & queue**
- New wash: type the plate and a returning vehicle fills in automatically, with its stamp card and membership.
- Price: package × vehicle type, plus add-ons, minus membership / free wash / promo code / manual discount. The total is calculated by the server, with the same rules as when saving.
- Queue board: Waiting → Washing → Done. The cashier assigns a washer and a wash bay when starting; a bay holds one car at a time.
- Payments: pay in full or in parts, across several methods (cash, QRIS, transfer, card, e-wallet). Printable receipt.

**Online booking & tracking**
- Public booking page with free time slots. Slots follow opening hours, closed days, package duration and the number of active bays.
- Each booking gets a private page where the customer can check or cancel it. Staff check bookings in, confirm them or mark no-shows.
- Every wash gets a private tracking link (`/t/<token>`) with live status, checklist progress and photos, and no personal data.

**Washers**
- A checklist per package, copied onto each job when it starts.
- Commission per washer: a fixed amount per car or a percentage of the price, recorded when the wash is finished.
- Before/after photos from the phone camera. Photos are shrunk in the browser and checked on the server (JPEG/PNG/WebP only, 8 MB max).

**WhatsApp**
- Messages for: car received, car ready, booking confirmed / received / cancelled, and a reminder 2 hours before a booking.
- In Indonesian or English: the customer's booking language, or a setting for walk-in customers.
- Without a gateway, staff send each message with one tap (WhatsApp opens with the text ready). With `WHATSAPP_TOKEN` (a Fonnte-compatible API), messages are sent automatically and failures can be retried.

**Loyalty**
- Stamp card: every Nth paid wash is free (add-ons are still charged).
- Promo codes: percent or fixed amount, with minimum spend, date range and usage limit.
- Memberships: prepaid plans such as 8 washes a month. A covered wash costs nothing and counts as paid.

**Money & operations**
- Stock: supplies with a low-stock warning. Purchases can be recorded as an expense automatically, and per-wash usage is deducted when a wash is finished.
- Expenses by category.
- Reports:
  - Money received per day
  - Profit (money received − expenses − commission)
  - By package, by vehicle type and by payment method
  - Busiest hours
  - Washer performance
  - Loyalty and promo usage
- CSV export (Excel-friendly) and a print / save-as-PDF view.
- Activity log: price changes, cancellations, discounts, payments, staff and settings changes, sign-ins and failed sign-ins.

## Run it

**On Windows:** double-click `JALANKAN.bat`. It checks Node.js, installs, fills demo data the first time, starts the server and opens http://localhost:3000/login (admin / admin123).

**Any system:**

Requires **Node.js 22.13 or newer**. SQLite is built into Node, so there is no database server to install.

```bash
npm install
npm run seed   # optional: ~6 weeks of demo data, washers (password washer123), bookings, memberships, stock
npm start      # http://localhost:3000
npm test       # 63 automated tests
```

Default login: **admin / admin123**. Change this password on the Staff page right away.

### Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where the database and uploaded photos are stored |
| `DB_PATH` | `$DATA_DIR/washing.db` | SQLite file (optional override) |
| `TZ` | `Asia/Jakarta` | Timezone for timestamps, "today" and booking slots |
| `SESSION_SECRET` | random at start | **Set this in production**, or everyone is logged out on restart |
| `BUSINESS_NAME` | `Sparkle Wash` | Name on the site, receipts and messages |
| `DEFAULT_LANG` | `id` | `id` or `en` for first-time visitors |
| `PUBLIC_URL` | — | Full site address for links in WhatsApp messages (can also be set in Settings) |
| `WHATSAPP_TOKEN` | — | Fonnte (or compatible) token; when set, messages are sent automatically |
| `WHATSAPP_API_URL` | `https://api.fonnte.com/send` | Gateway endpoint |
| `COOKIE_SECURE` | — | Set to `1` when served over HTTPS |
| `TRUST_PROXY` | — | Set when behind a reverse proxy, so rate limits see real client IPs |

Most shop settings live in the app under **Settings**: opening hours, slot length, booking rules, wash bays, stamp card, WhatsApp, website address.

### Back up

Everything is in `DATA_DIR`: the `washing.db` file and the `uploads/` folder of photos. Back up that folder.

## Security

- Passwords are hashed with scrypt. Sessions use HTTP-only cookies.
- Every form has a CSRF token, including photo uploads.
- Login and online booking are rate limited.
- Role checks happen on the server for every page and action. Washers only see their own jobs.
- Private links for bookings and tracking use random tokens. Tracking pages show no names or phone numbers.
- Uploaded photos are checked by their file contents, stored outside the public folder, and only served to people allowed to see them.
- CSV exports are protected against spreadsheet formula injection.

## Project layout

```
server.js               entry point + background job (WhatsApp sending, booking reminders)
src/app.js              Express setup, middleware, route mounting and role guards
src/db.js               SQLite connection, helpers; runs migrations + default data
src/migrations.js       versioned schema changes (PRAGMA user_version)
src/defaults.js         default price list, checklists, durations (EN + ID)
src/settings.js         shop settings with defaults
src/security.js         CSRF and rate limiting
src/i18n/               en.js / id.js dictionaries (hand-written Indonesian) + middleware
src/services/           business logic: transactions, payments, work (washers/bays/checklists),
                        bookings, notifications, marketing (promos/stamps/memberships),
                        photos, finance (stock/expenses), reports, audit
src/routes/             public, booking, staff (cashier), jobs (washers), admin
views/                  EJS pages; views/app/* is the staff area
public/                 CSS (design tokens: Vanilla Custard, Pale Sky, Deep Mocha) and JS
test/                   node:test suites (one per phase) + helpers
```

The promo videos and AI video prompts live in [FadelPermanaa/Video-Promosi](https://github.com/FadelPermanaa/Video-Promosi).

## Adding text

All screen text lives in `src/i18n/en.js` and `src/i18n/id.js` under the same keys. The tests fail if a key is missing in either language or used without being defined.
