#!/usr/bin/env node
"use strict"

/*
 * Explicit standalone validator package exporter CLI.
 *
 * Exports one or more JSON Schemas into a portable, self-contained CommonJS
 * package directory: each entry gets its own validator file, shared definition
 * schemas are inlined into every entry that references them, and all runtime
 * helpers / format modules are vendored so the output can be copied to another
 * directory and loaded without npm install or an Ajv installation.
 *
 * Nothing is written if any entry fails to compile (missing $ref, unknown
 * format, or custom keyword/format that cannot generate standalone code).
 *
 * Usage:
 *   node scripts/export-standalone.js --config spec/extras/standalone-export/export.config.json --out .standalone-package
 *
 * Config file (JSON):
 * {
 *   "ajvFormats": true,            // register formats from ajv-formats
 *   "ajvOptions": {"allErrors": true},
 *   "schemas": ["./defs.schema.json"],   // shared $id schemas (paths relative to config)
 *   "entries": [
 *     {"name": "user",  "schema": "./user.schema.json"},
 *     {"name": "order", "schema": "./order.schema.json"}
 *   ]
 * }
 *
 * Run `node scripts/export-standalone.js --help` for all flags.
 */

const fs = require("fs")
const path = require("path")
const {exportStandalonePackage} = require("../dist/standalone/package")

function parseArgs(argv) {
  const args = {config: undefined, out: undefined, ajvFormats: undefined, help: false}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--help" || a === "-h") args.help = true
    else if (a === "--config") args.config = argv[++i]
    else if (a === "--out" || a === "-o") args.out = argv[++i]
    else if (a === "--ajv-formats") args.ajvFormats = true
    else if (a === "--no-ajv-formats") args.ajvFormats = false
    else throw new Error(`unknown argument: ${a}`)
  }
  return args
}

const HELP = [
  "Usage: node scripts/export-standalone.js --config <file> --out <dir>",
  "",
  "  --config <file>       JSON export config (see header of this script)",
  "  --out, -o <dir>       output package directory (must be empty or absent)",
  "  --ajv-formats         register the ajv-formats full format set",
  "  --no-ajv-formats      do not register ajv-formats (default)",
  "  -h, --help            show this help",
  "",
  "Nothing is written when any schema fails to compile; exit code is non-zero.",
].join("\n")

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(HELP)
    return
  }
  if (!args.config) throw new Error("--config is required (use --help for usage)")
  if (!args.out) throw new Error("--out is required (use --help for usage)")

  const configPath = path.resolve(args.config)
  const configDir = path.dirname(configPath)
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"))

  const resolveSchema = (s) => {
    if (typeof s === "string") {
      return JSON.parse(fs.readFileSync(path.resolve(configDir, s), "utf8"))
    }
    if (s && typeof s === "object" && s.path) {
      const schema = JSON.parse(fs.readFileSync(path.resolve(configDir, s.path), "utf8"))
      if (s.id) schema.$id = s.id
      return schema
    }
    throw new Error("each schema must be a file path or {path, id?} object")
  }

  const config = {
    ajvOptions: raw.ajvOptions,
    ajvFormats: args.ajvFormats !== undefined ? args.ajvFormats : !!raw.ajvFormats,
    schemas: (raw.schemas || []).map(resolveSchema),
    entries: (raw.entries || []).map((e) => ({
      name: String(e.name),
      schema: typeof e.schema === "string" ? resolveSchema(e.schema) : resolveSchema(e),
    })),
  }

  const result = exportStandalonePackage(path.resolve(args.out), config)
  console.log(`standalone package written to ${result.outDir}`)
  for (const [name, file] of Object.entries(result.entryFiles)) {
    console.log(`  entry ${name} -> ${file}`)
  }
  const deps = Object.keys(result.dependencies)
  console.log(`  vendored dependencies: ${deps.length ? deps.join(", ") : "(none)"}`)
}

main()
