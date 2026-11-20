#!/usr/bin/env bash
# Build the Pass A image-cleaning pipeline to WASM.
# Output: clean/assets/hw.mjs + hw.wasm — the artifacts this package ships.
#
# Needs emcc on PATH:
#   source "$EMSDK/emsdk_env.sh"   (your emsdk folder)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../assets

emcc \
  src/core/image.c \
  src/core/utils.c \
  src/global/resize_gray.c \
  src/global/page_detect.c \
  src/global/homography.c \
  src/global/illumination.c \
  src/global/seams.c \
  src/global/lines.c \
  src/global/binarize.c \
  src/global/components.c \
  src/api.c \
  -I src \
  -O3 -msimd128 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sMAXIMUM_MEMORY=2GB \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32 \
  -o ../assets/hw.mjs

echo "OK: $(ls -la ../assets/)"

# The build writes into clean/assets/, which is what the package exports. Apps
# copy those two files into whatever directory they serve (an app might copy them to
# public/wasm/ via its `assets:wasm` script) and tell the pipeline where they
# landed with setWasmAssetBase(). The default is /wasm/.
