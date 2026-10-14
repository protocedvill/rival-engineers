#!/usr/bin/env bash
# Load a save in headless Factorio 2.0 (vanilla base only) with the re-save-dump mod and copy the
# entity dump to OUT.json. Uses its own write-data dir and config, so it never touches ~/.factorio or
# the test harness's .factorio-test/data. --benchmark mode opens no network port.
#
# Usage: tools/modules/run_dump.sh SAVE.zip OUT.json
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
save="$(realpath "$1")"
out="$2"
factorio="${FACTORIO_BIN:-$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir | xargs dirname)/.factorio-test/factorio/bin/x64/factorio}"
run="${RUN_DIR:-$here/out/factorio-run}"

mkdir -p "$run/config" "$run/mods"
cat > "$run/config/config.ini" <<EOF
[path]
read-data=$(dirname "$factorio")/../../data
write-data=$run
EOF
cat > "$run/mods/mod-list.json" <<'EOF'
{"mods":[{"name":"base","enabled":true},{"name":"elevated-rails","enabled":false},
{"name":"quality","enabled":false},{"name":"space-age","enabled":false},{"name":"re-save-dump","enabled":true}]}
EOF
rm -rf "$run/mods/re-save-dump" "$run/script-output/re-save-dump.json"
cp -r "$here/dump-mod/re-save-dump" "$run/mods/"

"$factorio" --config "$run/config/config.ini" --mod-directory "$run/mods" \
  --benchmark "$save" --benchmark-ticks 1 --benchmark-runs 1 2>&1 | tee "$run/last-run.log" | tail -n 15

cp "$run/script-output/re-save-dump.json" "$out"
cp "$run/script-output/re-prototypes.json" "$(dirname "$out")/prototypes-2.0.json"
echo "wrote $out"
