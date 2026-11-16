#!/bin/bash
# The LITE matcher: cpp/match.cpp with only the single-character surface bound
# (-DMILLIREC_LITE, see the guard in EMSCRIPTEN_BINDINGS) and size-first
# optimisation. Same source, same arithmetic — tuning/caps-lite.cjs --wasm
# dist/lite/millirec.js re-scores a version through it and must agree
# bit-for-bit with the full build. Output: dist/lite/millirec.{js,wasm}.
set -euo pipefail
cd "$(dirname "$0")/.."
# Emscripten: EMSDK names its folder (the one holding emsdk_env.sh); skipped when em++ is already on PATH
if ! command -v em++ >/dev/null 2>&1; then source "${EMSDK:?set EMSDK to your emsdk folder, or put em++ on PATH}/emsdk_env.sh" >/dev/null 2>&1; fi
mkdir -p dist/lite
FLAGS=(-Oz --closure 1 -s WASM=1 -s ALLOW_MEMORY_GROWTH -s MODULARIZE
  -s EXPORT_NAME="'ShapeID'" -s FILESYSTEM=0 -s ASSERTIONS=0
  -s ENVIRONMENT=worker,web,node
  --std=c++17 --bind -DMILLIREC_LITE)
em++ "${FLAGS[@]}" -o dist/lite/millirec.js cpp/match.cpp
ls -la dist/lite/
