# tools/modules: module sourcing

Tooling for SPEC §5.4 (Module Library). Python is stdlib-only. Run it with `python3 -I`, because it reads untrusted
downloads and save data.

On the M4 branch: `curate.py` (the curated module pipeline), `bpstring.py`, `factorioprints.py`, `data/` and
`samples/`, brought over from `proto/module-sourcing` (whose report, `docs/reports/proto-module-sourcing.md` on that
branch, has the findings). The save-harvesting tools (`run_dump.sh`, `dump-mod/`, `cluster.py`, `list_modules.py`,
`dump_stats.py`, the library tools) stay on the prototype branch until a milestone needs them.

| Tool | What it does |
|---|---|
| `curate.py show SPEC` / `build SPEC...` | Curated modules: blueprint (cached in `data/modules/sources/`) → normalised ModuleDef JSON in `data/modules/` per a spec in `curated/` (renames, recipe swaps, removals, additions, crop, ports, expand), plus a render dump and `ATTRIBUTION.md`. |

Inputs go in `input/` and outputs in `out/`. Both are git-ignored. Copy saves and the blueprint
library into `input/` first. Never point a tool at `~/.factorio`.

Prototype-branch tools (for reference):

| Tool | What it does |
|---|---|
| `run_dump.sh SAVE.zip OUT.json` | Loads a save in headless 2.0 (`--benchmark`, base mod only, own config/write-data dir under `out/factorio-run`) with `dump-mod/re-save-dump`. Writes all non-neutral entities, plus the recipes and machines they use. Also writes `prototypes-2.0.json` next to OUT. Saves must be from 1.0 or newer. |
| `dump_stats.py DUMP.json` | Entity and recipe inventory of a dump. |
| `cluster.py DUMP.json -o M.json [--render-dir D] [--whole]` | Clusters machines into candidate modules, infers ports and rates, normalises, and flags anything that needs review. Use `--whole` for a single blueprint. |
| `list_modules.py M.json [--early] [--clean]` | Prints one line per candidate. |
| `bpstring.py decode/encode/list/to-dump` | Blueprint string codec (`0` + base64(zlib(JSON))). `to-dump` turns a blueprint or book into dumps that `cluster.py` and `tools/render/render.py` can read. It converts 0.17/1.x directions and renames to 2.0. |
| `factorioprints.py search/fetch` | Reads factorioprints' public Firebase REST API. `fetch` writes the record plus `ATTRIBUTION.jsonl` (author, URL, licence). |
| `library-export-mod/re-library-export` | A one-time in-game helper. `/re-export-library` writes every library record as a blueprint string. It needs the graphical client, because a headless run has no local library. |
| `library-structure/run.sh DAT OUT.json` | Builds the third-party Go decoder and dumps the library's book tree, labels and entity counts. Blueprint bodies stay opaque. |
| `data/prototypes-2.0-base.json` | Vanilla 2.0.77 recipes, crafting speeds and entity tile sizes, written by the dump mod. |
| `samples/*.module.json` | Three example candidates, two from a save and one from factorioprints. |

Typical run:

```sh
cp ~/.factorio/saves/FactorySimulator2024.zip tools/modules/input/saves/
tools/modules/run_dump.sh tools/modules/input/saves/FactorySimulator2024.zip tools/modules/out/dumps/fs2024.json
python3 -I tools/modules/cluster.py tools/modules/out/dumps/fs2024.json -o tools/modules/out/fs2024-modules.json \
    --render-dir tools/modules/out/render/fs2024
python3 -I tools/modules/list_modules.py tools/modules/out/fs2024-modules.json --early
python3 -I tools/render/render.py tools/modules/out/render/fs2024/<id>.json -o module.png --scale 16

# Online
python3 -I tools/modules/factorioprints.py search science
python3 -I tools/modules/factorioprints.py fetch -o /some/empty/dir -- -KnQ865j-qQ21WoUPbd3
python3 -I tools/modules/bpstring.py to-dump /some/empty/dir/-KnQ865j-qQ21WoUPbd3.json -o tools/modules/out/bp/sci
python3 -I tools/modules/cluster.py tools/modules/out/bp/sci/000-*.json -o m.json --whole --min-machines 1
```

The candidate JSON is a superset of SPEC §5.4 `ModuleDef`. It adds `recipes` (all recipes in the module),
`ports[].items` and `item_source`, and `review` (flags, foreign tiles, missing ports). Entities keep the
dump fields (`x`, `y`, `tw`, `th`, …) so `render.py` can draw them.
