#!/usr/bin/env bash
# Structural dump of a copied blueprint-storage-2.dat (book tree, labels, entity counts) using the
# third-party Go decoder galpodlipnik1/factorio-blueprint-decoder (no licence file; used locally only,
# not vendored). Blueprint *bodies* stay opaque in that decoder, so this gives an inventory, not modules.
# For the actual blueprint strings use library-export-mod (one in-game command).
#
# The decoder accepts only storage versions 2.0.76/2.0.77; we add the version found in the file
# (2.0.72 for the user's copy, which decoded strictly with no diagnostics).
#
# Usage: tools/modules/library-structure/run.sh COPY_OF_blueprint-storage-2.dat OUT.json [WORKDIR]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dat="$(realpath "$1")"; out="$(realpath -m "$2")"
work="${3:-$here/../out/bpdecoder}"
commit=27bf2e544a2edbdfcb197dd5ae716376d3d13a2a
if [ ! -d "$work" ]; then
  git clone -q https://github.com/galpodlipnik1/factorio-blueprint-decoder "$work"
  git -C "$work" checkout -q "$commit"
fi
patch=$(od -An -tu2 -j4 -N2 "$dat" | tr -d ' ')
grep -q "Patch: $patch," "$work/decode.go" ||
  sed -i "s/{Major: 2, Minor: 0, Patch: 77, Build: 0},/&\n\t{Major: 2, Minor: 0, Patch: $patch, Build: 0},/" "$work/decode.go"
mkdir -p "$work/cmd/bpdump"
cp "$here/main.go.txt" "$work/cmd/bpdump/main.go"
go -C "$work" build -mod=mod -o bpdump ./cmd/bpdump
"$work/bpdump" "$dat" > "$out"
python3 -I "$here/summarize.py" "$out"
