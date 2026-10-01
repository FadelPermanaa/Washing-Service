# Video Promosi — Sparkle Wash

Video promosi 30 detik untuk **pemilik usaha cuci mobil/motor**. Semua layar di video adalah tampilan asli aplikasi (diambil dari data demo), lalu dianimasikan. Musik dan efek suara dibuat sendiri lewat kode, jadi bebas hak cipta.

| File | Ukuran | Untuk |
|---|---|---|
| [output/sparkle-wash-promo-16x9.mp4](output/sparkle-wash-promo-16x9.mp4) | 1920×1080 | YouTube, website, presentasi |
| [output/sparkle-wash-promo-9x16.mp4](output/sparkle-wash-promo-9x16.mp4) | 1080×1920 | Instagram Reels, TikTok, YouTube Shorts, Status WA |

## Alur video

| Detik | Adegan | Isi |
|---|---|---|
| 0–4,6 | Masalah | Latar gelap, kertas catatan berserakan, antrean mobil, jam berputar cepat. *"Antrean panjang. Catatan berantakan. Uang masuk nggak jelas?"* |
| 4,6–8,6 | Solusi | Gelembung pecah → layar terang, logo dan nama **Sparkle Wash** muncul |
| 8,6–13,8 | Kasir & antrean | Laptop dengan papan antrean, lalu form transaksi baru. Koin "Rp", chip *Membership · Promo · Kartu stempel* |
| 13,8–19,4 | Booking & WhatsApp | HP pelanggan memilih jam 10:30, pesan WhatsApp konfirmasi masuk, halaman pelacakan naik 3/6 → 5/6 langkah |
| 19,4–24,6 | Tim & laporan | Pencuci mencentang checklist satu per satu, laporan laba bulanan muncul |
| 24,6–30 | Ajakan (CTA) | Mobil bersih berkilau masuk, kartu *"Usaha cuci lebih rapi, pelanggan lebih puas."* dan tombol **Minta Demo Gratis** |

## Mengubah teks lalu render ulang

Teks CTA ada di bagian atas `<script>` di [stage.html](stage.html):

```js
const CONFIG = {
  brand: 'Sparkle Wash',
  headline: 'Usaha cuci lebih rapi,<br><em>pelanggan lebih puas.</em>',
  headlineVertical: 'Usaha cuci<br>lebih rapi,<br><em>pelanggan<br>lebih puas.</em>',
  cta: 'Minta Demo Gratis',
  ctaSub: 'Kasir · Antrean · Booking · WhatsApp · Laporan',
  footer: 'Sparkle Wash',
};
```

Teks lain (kalimat pembuka, judul tiap adegan, isi pesan WhatsApp) langsung ada di HTML-nya.

```bash
cd marketing/video
npm install                     # GSAP + Playwright
npx playwright install chromium # sekali saja
npm run build                   # → output/*.mp4  (perlu ffmpeg dan python3)
```

- **Lihat animasinya tanpa render:** buka `stage.html` di browser (tambahkan `?f=v` untuk versi vertikal).
- **Cek satu frame:** `node render.js h 12.5,27` → `preview/h-12.5.jpg`, `preview/h-27.jpg`.
- Kalau `ffmpeg` tidak ada di PATH: `FFMPEG=/lokasi/ffmpeg npm run build`.
- Render ±3 menit per format.

## Mengambil ulang screenshot aplikasi

Perlu dilakukan kalau tampilan aplikasi berubah (warna, logo, nama usaha).

```bash
# di folder utama proyek
npm run seed && npm start

# di terminal lain
cd marketing/video
node capture.js                 # → shots/*.png
```

`capture.js` **mengubah data demo** (mencentang checklist satu cucian langkah demi langkah), jadi jangan dijalankan ke data usaha yang asli. Pengaturan: `BASE_URL` (default `http://localhost:3000`) dan `DATA_DIR` (folder data yang sama dengan server).

Posisi animasi ketukan jari di layar HP mengikuti tata letak screenshot. Kalau tata letak halaman booking atau checklist berubah, sesuaikan posisi `#tap`, `#tap1`–`#tap3` di `stage.html` (dalam persen dari lebar dan tinggi screenshot).

## Isi folder

| File | Fungsi |
|---|---|
| `stage.html` | Semua adegan dan animasi (GSAP), ukuran 1920×1080 atau 1080×1920 |
| `render.js` | Merekam `stage.html` frame demi frame (30 fps) dengan Chromium |
| `audio.py` | Membuat musik dan efek suara (Python standar, tanpa library tambahan) |
| `capture.js` | Mengambil screenshot dari aplikasi demo |
| `build.sh` | Audio + render + encode jadi MP4 |
| `shots/` | Screenshot aplikasi yang dipakai di video |
| `fonts/` | Font Poppins (supaya hasil render selalu sama) |
| `output/` | Video jadi |

Mau versi video AI (3D/sinematik)? Pakai prompt di [../video-prompts](../video-prompts).
