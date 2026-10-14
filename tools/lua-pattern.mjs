// Lua patterns (the syntax of factorio-test filters) in JavaScript: enough to tell which tests a filter selects.
// Supports anchors, `.`, `%` classes and escapes, sets, and the quantifiers `* + - ?`. Throws on `%b`, `%f` and
// back-references, which the caller treats as "can't tell".

const CLASSES = {
  a: "A-Za-z",
  c: "\\x00-\\x1f\\x7f",
  d: "0-9",
  g: "!-~",
  l: "a-z",
  p: "!-/:-@\\[-`{-~",
  s: "\\t-\\r ",
  u: "A-Z",
  w: "A-Za-z0-9",
  x: "0-9A-Fa-f",
}

function escapeRe(ch) {
  return /[\\^$.*+?()[\]{}|/-]/.test(ch) ? "\\" + ch : ch
}

/** The class after a `%`: [regex for a single char, the same as set contents]. */
function percentClass(c) {
  const lower = c.toLowerCase()
  if (CLASSES[lower] !== undefined) {
    const inner = CLASSES[lower]
    return c === lower ? [`[${inner}]`, inner] : [`[^${inner}]`, null]
  }
  if (/[A-Za-z0-9]/.test(c)) throw new Error(`unsupported Lua pattern item %${c}`)
  return [escapeRe(c), escapeRe(c)]
}

/** Converts a Lua pattern to an equivalent RegExp (Unicode-unaware, like Lua: it works on bytes, we on UTF-16). */
export function luaPatternToRegExp(pattern) {
  let i = 0
  let out = ""
  if (pattern.startsWith("^")) {
    out += "^"
    i = 1
  }
  while (i < pattern.length) {
    const c = pattern[i]
    let item
    if (c === "$" && i === pattern.length - 1) {
      out += "$"
      i++
      continue
    } else if (c === "%") {
      const n = pattern[i + 1]
      if (n === undefined) throw new Error("malformed Lua pattern (ends with %)")
      if (n === "b" || n === "f" || /[0-9]/.test(n)) throw new Error(`unsupported Lua pattern item %${n}`)
      item = percentClass(n)[0]
      i += 2
    } else if (c === "[") {
      let j = i + 1
      let set = "["
      if (pattern[j] === "^") {
        set += "^"
        j++
      }
      let first = true
      while (j < pattern.length && (pattern[j] !== "]" || first)) {
        first = false
        const s = pattern[j]
        if (s === "%") {
          const [, inner] = percentClass(pattern[j + 1])
          if (inner === null) throw new Error("negated class inside a Lua set")
          set += inner
          j += 2
        } else if (pattern[j + 1] === "-" && pattern[j + 2] !== undefined && pattern[j + 2] !== "]") {
          set += escapeRe(s) + "-" + escapeRe(pattern[j + 2])
          j += 3
        } else {
          set += escapeRe(s)
          j++
        }
      }
      if (j >= pattern.length) throw new Error("malformed Lua pattern (missing ])")
      item = set + "]"
      i = j + 1
    } else if (c === ".") {
      item = "[\\s\\S]"
      i++
    } else {
      item = escapeRe(c)
      i++
    }
    const q = pattern[i]
    if (q === "*" || q === "+" || q === "?") {
      out += item + q
      i++
    } else if (q === "-") {
      out += item + "*?"
      i++
    } else {
      out += item
    }
  }
  return new RegExp(out)
}

/** Escapes a literal string so a Lua pattern matches it exactly. */
export function luaEscape(text) {
  return text.replace(/[\^$()%.[\]*+\-?]/g, "%$&")
}
