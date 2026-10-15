// npm run review: watch the AI live in your own (Steam) Factorio, in a separate review profile.
//
//   npm run review [-- options] [-- extra Factorio arguments]
//
//   --space-age        enable space-age, quality and elevated-rails (off by default)
//   --factions N       set the AI faction count (mod setting, kept in the profile until changed)
//   --crew N           set the crew size per faction (likewise)
//   --menu             open the main menu instead of starting the sandbox scenario
//   --load NAME        load a save from the review profile (.factorio-review/saves/NAME.zip)
//   --no-build         don't run `npm run build` first
//   --no-launch        set up the profile only
//   --via-steam        launch through `steam -applaunch 427520` instead of running the binary directly
//   --fresh-config     don't copy ~/.factorio/config/config.ini (graphics, keybindings) into a new profile
//
// The review profile is <main checkout>/.factorio-review (git-ignored): its own config.ini, mod-list.json,
// mod-settings.dat, saves and log. mods/rival-engineers is a symlink to <main checkout>/mod/build, so a
// `npm run build` in the main checkout is picked up the next time the game starts or reloads mods. ~/.factorio is
// only ever read (to copy graphics and keybinding settings into a new profile), never written.
import { execFileSync, spawn } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { getModSetting, readModSettings, setModSetting, writeModSettings } from "./mod-settings.mjs"

const STEAM_APP_ID = "427520"
const FACTORIO_DIR = process.env.FACTORIO_STEAM_DIR ?? join(homedir(), ".steam/steam/steamapps/common/Factorio")
const BINARY = join(FACTORIO_DIR, "bin/x64/factorio")
const DLC_MODS = ["space-age", "quality", "elevated-rails"]
const SETTING = { factions: "rival-engineers-faction-count", crew: "rival-engineers-crew-size" }

// ---- arguments ----
const opts = { spaceAge: false, build: true, launch: true, viaSteam: false, freshConfig: false, menu: false, extra: [] }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const int = (name) => {
    const n = Number(argv[++i])
    if (!Number.isInteger(n) || n < 0) fail(`${name} needs a whole number`)
    return n
  }
  if (a === "--space-age") opts.spaceAge = true
  else if (a === "--factions") opts.factions = int(a)
  else if (a === "--crew") opts.crew = int(a)
  else if (a === "--menu") opts.menu = true
  else if (a === "--load") opts.load = argv[++i]
  else if (a === "--no-build") opts.build = false
  else if (a === "--no-launch") opts.launch = false
  else if (a === "--via-steam") opts.viaSteam = true
  else if (a === "--fresh-config") opts.freshConfig = true
  else if (a === "--") {
    opts.extra = argv.slice(i + 1)
    break
  } else if (a === "-h" || a === "--help") {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"))
    process.exit(0)
  } else fail(`unknown option ${a} (see --help)`)
}

function fail(msg) {
  console.error(`review: ${msg}`)
  process.exit(1)
}

// ---- where things are ----
const here = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
/** The main checkout (not a worktree): where the user and other agents build. */
function mainCheckout() {
  try {
    const common = execFileSync("git", ["-C", here, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim()
    return dirname(common)
  } catch {
    return resolve(here)
  }
}
// REVIEW_ROOT overrides the checkout (e.g. to try a worktree's build in its own profile).
const main = process.env.REVIEW_ROOT ? resolve(process.env.REVIEW_ROOT) : mainCheckout()
const profile = join(main, ".factorio-review")
const configIni = join(profile, "config", "config.ini")
const modsDir = join(profile, "mods")
const buildDir = join(main, "mod", "build")
const did = []

// ---- 1. build ----
if (opts.build) {
  if (!existsSync(join(main, "node_modules"))) fail(`no node_modules in ${main}: run npm ci there first`)
  console.log(`review: building the mod in ${main}`)
  execFileSync("npm", ["run", "--silent", "build"], { cwd: main, stdio: "inherit" })
  did.push(`built ${buildDir}`)
} else if (!existsSync(join(buildDir, "info.json"))) fail(`${buildDir} is not built (drop --no-build)`)

// ---- 2. profile ----
for (const d of [profile, join(profile, "config"), modsDir, join(profile, "saves")]) mkdirSync(d, { recursive: true })

/** config.ini with our [path] section; other sections come from the existing profile config or ~/.factorio's. */
function writeConfig() {
  const pathSection = ["[path]", "read-data=__PATH__executable__/../../data", `write-data=${profile}`, ""]
  let base = ""
  let from = "defaults"
  if (existsSync(configIni)) {
    base = readFileSync(configIni, "utf8")
    from = "existing profile config"
  } else if (!opts.freshConfig && existsSync(join(homedir(), ".factorio/config/config.ini"))) {
    base = readFileSync(join(homedir(), ".factorio/config/config.ini"), "utf8") // read only
    from = "~/.factorio/config/config.ini (copied, not modified)"
  }
  const out = []
  let skip = false
  for (const line of base.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]/)
    if (header) skip = header[1] === "path"
    if (!skip && !line.startsWith("; generated by tools/review")) out.push(line)
  }
  const text = ["; generated by tools/review/review.mjs: the [path] section is rewritten on every run", ...pathSection, ...out].join("\n")
  const before = existsSync(configIni) ? readFileSync(configIni, "utf8") : undefined
  if (before !== text) {
    writeFileSync(configIni, text)
    did.push(`wrote ${configIni} (from ${from})`)
  }
}
writeConfig()

// mods/rival-engineers → <main>/mod/build
const link = join(modsDir, "rival-engineers")
let linkOk = false
try {
  const st = lstatSync(link)
  if (!st.isSymbolicLink()) fail(`${link} exists and is not a symlink; remove it`)
  linkOk = readlinkSync(link) === buildDir
  if (!linkOk) unlinkSync(link)
} catch (e) {
  if (e.code !== "ENOENT") throw e
}
if (!linkOk) {
  symlinkSync(buildDir, link)
  did.push(`linked ${link} → ${buildDir}`)
}

// mod-list.json: base + rival-engineers; the DLC mods per --space-age; anything else the user added is kept.
const modListFile = join(modsDir, "mod-list.json")
let modList = { mods: [] }
if (existsSync(modListFile)) modList = JSON.parse(readFileSync(modListFile, "utf8"))
const setMod = (name, enabled) => {
  const m = modList.mods.find((x) => x.name === name)
  if (m) m.enabled = enabled
  else modList.mods.push({ name, enabled })
}
setMod("base", true)
setMod("rival-engineers", true)
for (const m of DLC_MODS) setMod(m, opts.spaceAge)
writeFileSync(modListFile, JSON.stringify(modList, null, 2) + "\n")
did.push(`mods: base, rival-engineers${opts.spaceAge ? ", " + DLC_MODS.join(", ") : ""} (${opts.spaceAge ? "Space Age on" : "Space Age off"})`)

// mod-settings.dat: --factions / --crew
const settingsFile = join(modsDir, "mod-settings.dat")
const settings = readModSettings(settingsFile)
let settingsChanged = false
for (const key of ["factions", "crew"]) {
  if (opts[key] === undefined) continue
  setModSetting(settings, "runtime-global", SETTING[key], opts[key])
  settingsChanged = true
}
if (settingsChanged) writeModSettings(settingsFile, settings)
const shown = (key, def) => getModSetting(settings, "runtime-global", SETTING[key]) ?? `${def} (default)`
did.push(`settings: ${shown("factions", 2)} faction(s), crew ${shown("crew", 2)} each${settingsChanged ? " (updated)" : ""}`)

// ---- 3. launch ----
const args = ["--config", configIni]
let what = "the main menu"
if (opts.load) {
  const save = opts.load.endsWith(".zip") ? opts.load : `${opts.load}.zip`
  const path = existsSync(save) ? resolve(save) : join(profile, "saves", save)
  if (!existsSync(path)) fail(`no save ${path}`)
  args.push("--load-game", path)
  what = `save ${path}`
} else if (!opts.menu) {
  args.push("--load-scenario", "rival-engineers/sandbox")
  what = "the Rival Engineers sandbox scenario"
}
args.push(...opts.extra)

function running(pattern) {
  try {
    return execFileSync("pgrep", ["-f", "--", pattern], { encoding: "utf8" }).trim().length > 0
  } catch {
    return false
  }
}

console.log("review: " + did.join("\n        "))
if (!opts.launch) {
  console.log(`review: not launching. Command:\n  ${BINARY} ${args.join(" ")}`)
  process.exit(0)
}
if (running(`factorio --config ${configIni}`)) fail("a Factorio with the review profile is already running; quit it first (or use --no-launch)")
const logFile = join(profile, "launch.log")
const out = openSync(logFile, "w")
let child
if (opts.viaSteam) {
  child = spawn("steam", ["-applaunch", STEAM_APP_ID, ...args], { detached: true, stdio: ["ignore", out, out] })
} else {
  if (!existsSync(BINARY)) fail(`Factorio not found at ${BINARY} (set FACTORIO_STEAM_DIR)`)
  if (!running("steam")) console.log("review: Steam does not seem to be running; start it first if Factorio refuses to start (or use --via-steam)")
  // Started outside Steam, the Steam API asks to "restart" the game through Steam, which drops our arguments.
  // Naming the app (steam_appid.txt in the working directory, SteamAppId) makes it attach to the running Steam.
  writeFileSync(join(profile, "steam_appid.txt"), STEAM_APP_ID + "\n")
  const env = { ...process.env, SteamAppId: STEAM_APP_ID, SteamGameId: STEAM_APP_ID }
  child = spawn(BINARY, args, { detached: true, stdio: ["ignore", out, out], cwd: profile, env })
}
child.unref()
console.log(`review: launched Factorio (pid ${child.pid}) with ${what}`)
console.log(`        profile ${profile}`)
console.log(`        logs    ${logFile} and ${join(profile, "factorio-current.log")}`)
console.log("        in game: Ctrl+Shift+I (or the magnifier on the shortcut bar) toggles the inspector")
