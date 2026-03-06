#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <source-image-path>"
  exit 1
fi

SRC="$1"
OUT_DIR="public/images"
mkdir -p "$OUT_DIR"

gen_with_cwebp() {
  local size="$1"
  cwebp -quiet -q 90 -resize "$size" "$size" "$SRC" -o "$OUT_DIR/gumball-machine-${size}.webp"
}

gen_with_magick() {
  local size="$1"
  magick "$SRC" -resize "${size}x${size}^" -gravity center -extent "${size}x${size}" -quality 90 "$OUT_DIR/gumball-machine-${size}.webp"
}

if command -v cwebp >/dev/null 2>&1; then
  gen_with_cwebp 1024
  gen_with_cwebp 1536
  gen_with_cwebp 2048
elif command -v magick >/dev/null 2>&1; then
  gen_with_magick 1024
  gen_with_magick 1536
  gen_with_magick 2048
else
  echo "Neither cwebp nor ImageMagick (magick) was found."
  echo "Install one of them, then rerun."
  exit 1
fi

echo "Wrote:"
echo "  $OUT_DIR/gumball-machine-1024.webp"
echo "  $OUT_DIR/gumball-machine-1536.webp"
echo "  $OUT_DIR/gumball-machine-2048.webp"
