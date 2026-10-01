#!/bin/sh
# Adds the Linea.js branding to a finished promo video, in place:
#   - corner watermark from the first frame (bottom-right on 16:9, top-right on 9:16,
#     where Reels/TikTok buttons and captions do not cover it)
#   - the 3.6-second Linea.js closing animation appended at the end
#
#   sh apply-brand.sh output/video-16x9.mp4 h
#   sh apply-brand.sh output/video-9x16.mp4 v
# Run it once per freshly rendered video (running it twice adds the branding twice).
set -e
IN="$1"; FMT="$2"
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$DIR/dist/outro-16x9.mp4" ] && DIR="$DIR/dist"   # inside the linea.js source folder
FFMPEG=${FFMPEG:-ffmpeg}
if [ "$FMT" = v ]; then
  WM="$DIR/watermark-9x16.png"; OUTRO="$DIR/outro-9x16.mp4"; POS="W-w-36:150"
else
  WM="$DIR/watermark-16x9.png"; OUTRO="$DIR/outro-16x9.mp4"; POS="W-w-36:H-h-36"
fi
TMP="${IN%.mp4}.branding.mp4"
"$FFMPEG" -y -loglevel error -i "$IN" -i "$WM" -i "$OUTRO" -filter_complex \
  "[0:v][1:v]overlay=$POS:format=auto,format=yuv420p,setsar=1[main];[0:a]aresample=44100,aformat=channel_layouts=stereo[ma];[2:v]setsar=1[ov];[2:a]aresample=44100,aformat=channel_layouts=stereo[oa];[main][ma][ov][oa]concat=n=2:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -crf 20 -preset slow -r 30 -c:a aac -b:a 192k -movflags +faststart "$TMP"
mv "$TMP" "$IN"
echo "Branded: $IN"
