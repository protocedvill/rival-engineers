// Reads and writes Factorio's mod-settings.dat (a binary property tree), so `npm run review` can set
// runtime-global settings such as the faction count in the review profile without opening the game.
//
// Format (Factorio 2.0): version as 4 × u16 (major, minor, patch, build), a bool (u8 0), then one property tree.
// A tree node is: u8 type, u8 any-type flag, then the value:
//   0 none · 1 bool (u8) · 2 double (f64) · 3 string · 4 list · 5 dictionary · 6 signed int64 · 7 unsigned int64
// String: u8 "empty" flag, then (if not empty) a space-optimised u32 length (u8, or 0xFF + u32) and the bytes.
// List / dictionary: u32 count, then per entry a string key and a node (list keys are empty strings).
import { existsSync, readFileSync, writeFileSync } from "node:fs"

class Reader {
  constructor(buf) {
    this.buf = buf
    this.pos = 0
  }
  u8() {
    return this.buf.readUInt8(this.pos++)
  }
  u16() {
    const v = this.buf.readUInt16LE(this.pos)
    this.pos += 2
    return v
  }
  u32() {
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }
  string() {
    if (this.u8() !== 0) return ""
    let len = this.u8()
    if (len === 0xff) len = this.u32()
    const s = this.buf.toString("utf8", this.pos, this.pos + len)
    this.pos += len
    return s
  }
  node() {
    const type = this.u8()
    this.u8() // any-type flag
    switch (type) {
      case 0:
        return { type, value: null }
      case 1:
        return { type, value: this.u8() !== 0 }
      case 2: {
        const v = this.buf.readDoubleLE(this.pos)
        this.pos += 8
        return { type, value: v }
      }
      case 3:
        return { type, value: this.string() }
      case 4:
      case 5: {
        const n = this.u32()
        const entries = []
        for (let i = 0; i < n; i++) entries.push([this.string(), this.node()])
        return { type, value: entries }
      }
      case 6: {
        const v = this.buf.readBigInt64LE(this.pos)
        this.pos += 8
        return { type, value: v }
      }
      case 7: {
        const v = this.buf.readBigUInt64LE(this.pos)
        this.pos += 8
        return { type, value: v }
      }
      default:
        throw new Error(`mod-settings.dat: unknown property tree type ${type} at byte ${this.pos - 2}`)
    }
  }
}

function writeString(parts, s) {
  if (s === "") {
    parts.push(Buffer.from([1]))
    return
  }
  const bytes = Buffer.from(s, "utf8")
  if (bytes.length < 0xff) parts.push(Buffer.from([0, bytes.length]))
  else {
    const b = Buffer.alloc(6)
    b.writeUInt8(0, 0)
    b.writeUInt8(0xff, 1)
    b.writeUInt32LE(bytes.length, 2)
    parts.push(b)
  }
  parts.push(bytes)
}

function writeNode(parts, node) {
  parts.push(Buffer.from([node.type, 0]))
  switch (node.type) {
    case 0:
      return
    case 1:
      parts.push(Buffer.from([node.value ? 1 : 0]))
      return
    case 2: {
      const b = Buffer.alloc(8)
      b.writeDoubleLE(node.value)
      parts.push(b)
      return
    }
    case 3:
      writeString(parts, node.value)
      return
    case 4:
    case 5: {
      const b = Buffer.alloc(4)
      b.writeUInt32LE(node.value.length)
      parts.push(b)
      for (const [k, v] of node.value) {
        writeString(parts, k)
        writeNode(parts, v)
      }
      return
    }
    case 6:
    case 7: {
      const b = Buffer.alloc(8)
      if (node.type === 6) b.writeBigInt64LE(BigInt(node.value))
      else b.writeBigUInt64LE(BigInt(node.value))
      parts.push(b)
      return
    }
  }
}

/** { version: [4 numbers], tree } or a fresh empty settings file for `version`. */
export function readModSettings(file, version = [2, 0, 77, 0]) {
  if (!existsSync(file)) {
    const dict = (entries) => ({ type: 5, value: entries })
    return { version, tree: dict([["startup", dict([])], ["runtime-global", dict([])], ["runtime-per-user", dict([])]]) }
  }
  const r = new Reader(readFileSync(file))
  const v = [r.u16(), r.u16(), r.u16(), r.u16()]
  r.u8()
  return { version: v, tree: r.node() }
}

export function writeModSettings(file, settings) {
  const head = Buffer.alloc(9)
  settings.version.forEach((n, i) => head.writeUInt16LE(n, 2 * i))
  const parts = [head]
  writeNode(parts, settings.tree)
  writeFileSync(file, Buffer.concat(parts))
}

function section(settings, scope) {
  let entry = settings.tree.value.find(([k]) => k === scope)
  if (!entry) {
    entry = [scope, { type: 5, value: [] }]
    settings.tree.value.push(entry)
  }
  return entry[1]
}

/** Sets a setting's value: ints as int64, other numbers as double, booleans, strings. */
export function setModSetting(settings, scope, name, value) {
  const sec = section(settings, scope)
  let node
  if (typeof value === "boolean") node = { type: 1, value }
  else if (typeof value === "string") node = { type: 3, value }
  else if (typeof value === "bigint" || Number.isInteger(value)) node = { type: 6, value: BigInt(value) }
  else node = { type: 2, value }
  const wrapped = { type: 5, value: [["value", node]] }
  const existing = sec.value.find(([k]) => k === name)
  if (existing) existing[1] = wrapped
  else sec.value.push([name, wrapped])
}

export function getModSetting(settings, scope, name) {
  const sec = settings.tree.value.find(([k]) => k === scope)?.[1]
  const entry = sec?.value.find(([k]) => k === name)?.[1]
  const v = entry?.value.find(([k]) => k === "value")?.[1]?.value
  return typeof v === "bigint" ? Number(v) : v
}
