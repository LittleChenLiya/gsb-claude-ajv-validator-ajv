#!/usr/bin/env node
"use strict"

/**
 * Standalone package export CLI.
 *
 * Usage:
 *   node scripts/standalone-package.js --schema <schema.json> --id <id> --out <dir> [--format <name>]
 *
 * Generates a standalone validator package from a JSON Schema file.
 */

const fs = require("fs")
const path = require("path")

function parseArgs(argv) {
  const args = {schema: null, id: null, out: null, formats: [], esm: false}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--schema" || arg === "-s") {
      args.schema = argv[++i]
    } else if (arg === "--id" || arg === "-i") {
      args.id = argv[++i]
    } else if (arg === "--out" || arg === "-o") {
      args.out = argv[++i]
    } else if (arg === "--format" || arg === "-f") {
      args.formats.push(argv[++i])
    } else if (arg === "--esm") {
      args.esm = true
    } else if (arg === "--help" || arg === "-h") {
      args.help = true
    }
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help || !args.schema || !args.id || !args.out) {
    console.log(`Standalone package export CLI

Usage:
  node scripts/standalone-package.js --schema <schema.json> --id <id> --out <dir> [options]

Options:
  -s, --schema <file>   Path to JSON Schema file (required)
  -i, --id <id>         Schema $id to export (required)
  -o, --out <dir>       Output directory (required)
  -f, --format <name>   Add a RegExp format (can be repeated)
      --esm             Generate ESM modules
  -h, --help            Show this help message

Example:
  node scripts/standalone-package.js -s user.json -i user.json -o ./validator-package
`)
    process.exit(args.help ? 0 : 1)
  }

  const Ajv = require("../dist/ajv").default
  const standalonePackage = require("../dist/standalone/package").default

  const schemaPath = path.resolve(args.schema)
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"))

  const ajv = new Ajv({code: {source: true}})

  for (const fmt of args.formats) {
    const eq = fmt.indexOf("=")
    if (eq > 0) {
      const name = fmt.slice(0, eq)
      const pattern = fmt.slice(eq + 1)
      ajv.addFormat(name, new RegExp(pattern))
    } else {
      ajv.addFormat(fmt, true)
    }
  }

  ajv.addSchema(schema)

  const outDir = path.resolve(args.out)
  standalonePackage(ajv, {[args.id]: args.id}, {outDir, esm: args.esm})

  console.log(`Standalone package generated at: ${outDir}`)
}

main()
