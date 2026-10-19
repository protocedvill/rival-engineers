#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const json = process.argv.includes("--json")

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

function bugRows() {
  const rows = []
  for (const line of readFileSync(join(root, "docs", "BUGS.md"), "utf8").split("\n")) {
    if (!/^\| B\d+ /.test(line)) continue
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 4) continue
    const [id, reported, description, status] = cells
    rows.push({ id, reported, description, status })
  }
  return rows
}

function latestReport() {
  const dir = join(root, "docs", "reports")
  const files = readdirSync(dir).filter((name) => name.endsWith("-report.md"))
    .map((name) => ({ name, milestone: Number(/^M(\d+)/.exec(name)?.[1] ?? -1), mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.milestone - a.milestone || b.mtime - a.mtime)
  if (files.length === 0) return undefined
  const file = files[0].name
  const headings = readFileSync(join(dir, file), "utf8").split("\n").filter((line) => /^## /.test(line))
  return { file: `docs/reports/${file}`, lastSection: headings.at(-1)?.slice(3) }
}

const bugs = bugRows()
const open = bugs.filter((bug) => !/^fixed\b/i.test(bug.status))
const dirtyLines = git("status", "--short").split("\n").filter(Boolean)
const status = {
  branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  commit: git("rev-parse", "HEAD"),
  commitSubject: git("log", "-1", "--format=%s"),
  dirty: dirtyLines,
  latestReport: latestReport(),
  bugs: { total: bugs.length, unresolved: open },
}

if (json) {
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
} else {
  console.log(`Branch: ${status.branch}`)
  console.log(`HEAD:   ${status.commit.slice(0, 12)} ${status.commitSubject}`)
  console.log(`Tree:   ${status.dirty.length === 0 ? "clean" : `${status.dirty.length} changed path(s)`}`)
  if (status.dirty.length > 0) for (const line of status.dirty) console.log(`        ${line}`)
  if (status.latestReport) console.log(`Report: ${status.latestReport.file}${status.latestReport.lastSection ? ` — ${status.latestReport.lastSection}` : ""}`)
  console.log(`Bugs:   ${open.length} unresolved / ${bugs.length} tracked`)
  for (const bug of open) {
    const summary = bug.description.replace(/\*\*/g, "").replace(/`/g, "").slice(0, 110)
    console.log(`        ${bug.id} [${bug.status}] ${summary}${bug.description.length > 110 ? "…" : ""}`)
  }
  console.log("\nBefore editing: read AGENTS.md and the routed guide for the task.")
}
