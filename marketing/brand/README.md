# Branding video Linea.js

Semua video promosi Linea.js memakai branding yang sama:

- **Watermark di pojok** sejak frame pertama: logo Linea.js + tulisan "Linea.js".
  - 16:9: pojok kanan bawah.
  - 9:16: pojok kanan atas, karena tombol dan teks Reels/TikTok menutupi bagian bawah dan samping kanan.
- **Animasi penutup 3,6 detik** setelah video selesai: tulisan "dibuat oleh", lalu logo Linea.js dan namanya, dengan efek suara.

## Isi folder

| File | Fungsi |
|---|---|
| `apply-brand.sh` | Menempelkan watermark dan animasi penutup ke sebuah video |
| `outro-16x9.mp4`, `outro-9x16.mp4` | Animasi penutup |
| `watermark-16x9.png`, `watermark-9x16.png` | Watermark transparan |

## Cara pakai

Folder ini salinan dari `linea.js/marketing/brand/dist` (sumber animasinya ada di repo linea.js). Di akhir `build.sh` setiap video:

```sh
FFMPEG="$FFMPEG" sh ../brand/apply-brand.sh output/nama-16x9.mp4 h
FFMPEG="$FFMPEG" sh ../brand/apply-brand.sh output/nama-9x16.mp4 v
```

Jalankan sekali untuk setiap video yang baru di-render. Kalau dijalankan dua kali, branding-nya ikut dobel.

## Mengubah logo atau animasi

Sumbernya ada di repo **linea.js**, folder `marketing/brand/`. Ubah di sana, jalankan `npm run build`, lalu salin isi `dist/` ke folder ini.
