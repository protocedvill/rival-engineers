// T4 determinism check (SPEC §7): a canonical dump of the mod's whole state, so two runs of one seed (or a run resumed
// from a save) can be compared byte for byte at the same tick. Storage is written with sorted keys and full-precision
// numbers; Lua objects as their kind and identity; the factions' entities sorted by name and position. The harness
// (`tools/harness/determinism.py`) hashes and diffs the files.

const FLUSH_AT = 4096

class Writer {
  private parts: string[] = []
  private first = true
  constructor(private readonly file: string) {}
  put(s: string): void {
    this.parts.push(s)
    if (this.parts.length >= FLUSH_AT) this.flush()
  }
  flush(): void {
    if (this.parts.length === 0 && !this.first) return
    helpers.write_file(this.file, table.concat(this.parts), !this.first)
    this.first = false
    this.parts = []
  }
}

function num(n: number): string {
  if (n === math.floor(n) && math.abs(n) < 2 ** 53) return string.format("%d", n)
  return string.format("%.17g", n)
}

function keyOrder(k: unknown): string {
  return type(k) === "number" ? string.format("n%020.6f", k as number) : `s${tostring(k)}`
}

function luaObject(v: unknown): string {
  const o = v as { object_name?: string; valid?: boolean; name?: string; unit_number?: number; position?: { x: number; y: number }; index?: number }
  const kind = o.object_name ?? "userdata"
  if (o.valid === false) return `<${kind} invalid>`
  if (kind === "LuaEntity") return `<LuaEntity ${o.name}#${o.unit_number ?? "-"}@${num(o.position!.x)},${num(o.position!.y)}>`
  if (kind === "LuaProfiler") return "<LuaProfiler>"
  if (kind === "LuaForce" || kind === "LuaSurface") return `<${kind} ${o.name}>`
  return `<${kind}>`
}

function value(w: Writer, v: unknown, open: LuaTable<object, boolean>): void {
  const t = type(v)
  if (t === "number") w.put(num(v as number))
  else if (t === "string") w.put(string.format("%q", v as string))
  else if (t === "boolean" || t === "nil") w.put(tostring(v))
  else if (t === "userdata") w.put(luaObject(v))
  else if (t === "table") {
    const tbl = v as object
    if ((tbl as { object_name?: string }).object_name !== undefined) {
      w.put(luaObject(v))
      return
    }
    if (open.get(tbl)) {
      w.put("<cycle>")
      return
    }
    open.set(tbl, true)
    const keys: unknown[] = []
    for (const [k] of pairs(tbl)) keys.push(k)
    const order: Record<string, unknown> = {}
    const names: string[] = []
    for (const k of keys) {
      const s = keyOrder(k)
      order[s] = k
      names.push(s)
    }
    table.sort(names)
    w.put("{")
    for (const s of names) {
      const k = order[s]
      w.put(s)
      w.put("=")
      value(w, (tbl as Record<string, unknown>)[k as string], open)
      w.put(",")
    }
    w.put("}")
    open.set(tbl, false)
  } else w.put(`<${t}>`)
}

/** Writes the canonical state to script-output/`file`; returns the tick. */
export function writeStateDump(file: string): number {
  const w = new Writer(file)
  w.put(`tick=${game.tick}\nstorage=`)
  value(w, storage, new LuaTable<object, boolean>())
  w.put("\n")
  const forces: string[] = []
  for (const [, f] of pairs(storage.factions ?? {})) forces.push(f.force)
  table.sort(forces)
  for (const force of forces) {
    const lines: string[] = []
    for (const [, surface] of pairs(game.surfaces)) {
      for (const e of surface.find_entities_filtered({ force })) {
        lines.push(`${surface.name} ${e.name} ${num(e.position.x)},${num(e.position.y)} d${e.direction}`)
      }
    }
    table.sort(lines)
    w.put(`force ${force} ${lines.length}\n`)
    for (const l of lines) w.put(l + "\n")
    const tech: string[] = []
    for (const [name, t] of pairs(game.forces[force].technologies)) if (t.researched) tech.push(name)
    table.sort(tech)
    w.put(`researched ${table.concat(tech, " ")}\n`)
  }
  w.flush()
  return game.tick
}
