#!/bin/sh
# Render the promo video in both formats:
#   output/sparkle-wash-promo-16x9.mp4  (1920x1080, YouTube / website)
#   output/sparkle-wash-promo-9x16.mp4  (1080x1920, Reels / TikTok / Shorts)
# Needs: node, python3, ffmpeg (set FFMPEG=/path/to/ffmpeg if it is not on PATH).
set -e
cd "$(dirname "$0")"
FFMPEG=${FFMPEG:-ffmpeg}

python3 audio.py
mkdir -p output
for fmt in h v; do
  rm -rf "frames/$fmt"
  node render.js "$fmt"
done
"$FFMPEG" -y -loglevel error -framerate 30 -i frames/h/%05d.jpg -i audio.wav \
  -c:v libx264 -pix_fmt yuv420p -crf 20 -preset slow -tune animation \
  -c:a aac -b:a 192k -shortest -movflags +faststart output/sparkle-wash-promo-16x9.mp4
"$FFMPEG" -y -loglevel error -framerate 30 -i frames/v/%05d.jpg -i audio.wav \
  -c:v libx264 -pix_fmt yuv420p -crf 20 -preset slow -tune animation \
  -c:a aac -b:a 192k -shortest -movflags +faststart output/sparkle-wash-promo-9x16.mp4
# Linea.js watermark from the first frame + closing animation (see ../brand/README.md)
FFMPEG="$FFMPEG" sh ../brand/apply-brand.sh output/sparkle-wash-promo-16x9.mp4 h
FFMPEG="$FFMPEG" sh ../brand/apply-brand.sh output/sparkle-wash-promo-9x16.mp4 v
rm -rf frames
echo "Done: output/"
