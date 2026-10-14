# Rival Engineers

A Factorio 2.0 mod in which AI factions crew physical engineers that build factories the way players do.
See [`docs/SPEC.md`](docs/SPEC.md) for the full design and milestones.

## Development

Requirements: Node 22, Python 3 with Pillow (renderer), and Linux (headless Factorio).

```bash
npm ci
# one-time: isolated headless Factorio for tests (never uses ~/.factorio)
mkdir -p .factorio-test && curl -fsSL https://factorio.com/get-download/2.0.77/headless/linux64 | tar -xJ -C .factorio-test
mkdir -p .factorio-test/data/mods && cp ci/mods/*.zip .factorio-test/data/mods/

npm run typecheck        # T0
npm test                 # build + in-game tests (T2) on headless Factorio
npm test -- "pattern"    # filter tests by Lua pattern
```

Rendering entity dumps (written by the `dump_entities` remote call to `.factorio-test/data/script-output/`):

```bash
python3 tools/render/render.py DUMP.json -o out/frame.png
python3 tools/render/render.py frames/*.json --gif -o out/timelapse.gif
```

Layout: `mod/src` holds the TypeScript sources (`control.ts` runtime, `settings.ts` settings stage,
`test/` in-game tests), `mod/static` holds files copied verbatim into the mod, `tools/` holds the build,
render and (later) harness and module tooling, and `ci/mods` holds vendored test-only mods.
