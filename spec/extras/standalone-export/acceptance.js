"use strict"

/*
 * Small, deterministic acceptance test for the explicit standalone validator
 * package exporter (lib/standalone/package.ts, compiled to dist).
 *
 * It verifies:
 *   1. Two entries sharing a defs schema export to separate files and, after
 *      the package is copied to a different directory, still validate.
 *   2. An unknown format aborts the export - no package is generated.
 *   3. A custom keyword without standalone code is reported unsupported and no
 *      package is generated.
 *   4. Exported validators return the same results (and errors) as the original
 *      Ajv compilation, including useDefaults default filling.
 *   5. The output contains no absolute paths of this machine and no process
 *      environment values; every require is relative (the package is portable).
 *
 * Run with: npm run standalone:acceptance (builds dist first).
 */

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const {execFileSync} = require("child_process")
const Ajv = require("../../../dist/ajv")
const {fullFormats} = require("ajv-formats/dist/formats")
const {exportStandalonePackage} = require("../../../dist/standalone/package")

const ROOT = path.resolve(__dirname, "../../..")
const FIXTURES = __dirname
const WORK = path.join(ROOT, ".standalone-acceptance")

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL - ${name}`)
    console.error(e && e.stack ? e.stack : e)
  }
}

function resetWork() {
  fs.rmSync(WORK, {recursive: true, force: true})
  fs.mkdirSync(WORK, {recursive: true})
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function listFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(p))
    else out.push(p)
  }
  return out
}

// Build the same compiling Ajv setup the exporter uses for the fixture config.
function compileOriginal() {
  const ajv = new Ajv({useDefaults: true, allErrors: true, strict: true})
  for (const [name, def] of Object.entries(fullFormats)) ajv.addFormat(name, def)
  ajv.addSchema(readJson(path.join(FIXTURES, "defs.schema.json")))
  const user = ajv.compile(readJson(path.join(FIXTURES, "user.schema.json")))
  const order = ajv.compile(readJson(path.join(FIXTURES, "order.schema.json")))
  return {user, order}
}

const userCases = [
  {
    data: {
      id: 1,
      name: "ann",
      email: "ann@example.com",
      createdAt: "2026-10-06T12:00:00Z",
    },
    after: {
      id: 1,
      name: "ann",
      email: "ann@example.com",
      createdAt: "2026-10-06T12:00:00Z",
      role: "member",
    },
  },
  {
    data: {id: 1, name: "ann", email: "nope", role: "admin", extra: 1},
    errorKeywords: ["format", "additionalProperties"],
  },
  {
    data: {id: 0, name: "", email: "ann@example.com"},
    errorKeywords: ["minimum", "minLength"],
  },
  {
    data: {name: "ann"},
    errorKeywords: ["required"],
  },
  {
    data: {id: 1, name: "ann", email: "ann@example.com", createdAt: "not-a-date"},
    errorKeywords: ["format"],
  },
]

const orderCases = [
  {
    data: {
      id: 7,
      customer: {
        id: 2,
        name: "bo",
        email: "bo@example.com",
        createdAt: "2026-10-06T08:30:00Z",
      },
      total: 12.5,
    },
    after: {
      id: 7,
      customer: {
        id: 2,
        name: "bo",
        email: "bo@example.com",
        createdAt: "2026-10-06T08:30:00Z",
        role: "member",
      },
      total: 12.5,
    },
  },
  {
    data: {id: 7, customer: {id: 2, name: "bo", email: "bad"}, total: -1},
    errorKeywords: ["format", "minimum"],
  },
  {
    data: {id: 7, total: 1},
    errorKeywords: ["required"],
  },
]

function deepClone(x) {
  return JSON.parse(JSON.stringify(x))
}

function keywords(errs) {
  return [...(errs || [])].map((e) => e.keyword).sort()
}

function runComparison(label, validate) {
  const original = compileOriginal()
  const check = (kind, cases) => {
    for (const c of cases) {
      const a = deepClone(c.data)
      const b = deepClone(c.data)
      const okA = original[kind](a)
      const okB = validate[kind](b)
      const shown = JSON.stringify(c.data)
      assert.strictEqual(okB, okA, `${label} ${kind} result mismatch for ${shown}`)
      assert.deepStrictEqual(
        keywords(validate[kind].errors),
        keywords(original[kind].errors),
        `${label} ${kind} error keywords mismatch for ${shown}`
      )
      if (c.after) assert.deepStrictEqual(b, c.after, `${label} ${kind} defaults mismatch`)
      else assert.deepStrictEqual(b, a, `${label} ${kind} data must be untouched on failure`)
    }
  }
  check("user", userCases)
  check("order", orderCases)
}

test("exports package: two entries share defs and validate after moving directory", () => {
  resetWork()
  const outDir = path.join(WORK, "pkg")
  const config = readJson(path.join(FIXTURES, "export.config.json"))
  const result = exportStandalonePackage(outDir, {
    ajvFormats: true,
    ajvOptions: config.ajvOptions,
    schemas: config.schemas.map((s) => readJson(path.join(FIXTURES, s))),
    entries: config.entries.map((e) => ({
      name: e.name,
      schema: readJson(path.join(FIXTURES, e.schema)),
    })),
  })

  // Two entry files, defs inlined into each (shared export).
  assert.strictEqual(Object.keys(result.entryFiles).length, 2)
  assert.ok(fs.existsSync(path.join(outDir, result.entryFiles.user)))
  assert.ok(fs.existsSync(path.join(outDir, result.entryFiles.order)))

  const manifest = readJson(path.join(outDir, "package.json"))
  assert.strictEqual(manifest.main, result.entryFiles.user)
  assert.deepStrictEqual(manifest.standaloneExports, result.entryFiles)
  assert.ok(manifest.dependencies.ajv, "manifest lists vendored ajv runtime")
  assert.ok(
    manifest.dependencies["ajv-formats"],
    "manifest lists vendored ajv-formats used by email format"
  )

  // Original Ajv vs freshly exported package, in place.
  runComparison("in-place", loadValidators(outDir, result.entryFiles))

  // Copy the package to a different directory (outside the repo worktree) and
  // load it there: only relative requires may be used.
  const movedDir = path.join(WORK, "relocated", "validators")
  fs.mkdirSync(path.dirname(movedDir), {recursive: true})
  fs.cpSync(outDir, movedDir, {recursive: true})
  const moved = loadValidators(movedDir, result.entryFiles)
  runComparison("relocated", moved)

  // The package is self-contained: no bare require anywhere in the output.
  const bare = []
  for (const file of listFiles(outDir)) {
    if (!file.endsWith(".js")) continue
    const src = fs.readFileSync(file, "utf8")
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!m[1].startsWith(".")) bare.push(`${path.relative(outDir, file)}: ${m[1]}`)
    }
  }
  assert.deepStrictEqual(bare, [], `found bare (non-portable) requires: ${bare.join(", ")}`)

  // No machine-specific paths or environment values are embedded.
  const cwd = ROOT.replace(/\\/g, "/").toLowerCase()
  const home = os.homedir().replace(/\\/g, "/").toLowerCase()
  for (const file of listFiles(outDir)) {
    const src = fs.readFileSync(file, "utf8").toLowerCase()
    assert.ok(!src.includes(cwd), `${path.relative(outDir, file)} embeds worktree path`)
    assert.ok(!src.includes(home), `${path.relative(outDir, file)} embeds home path`)
  }
  const secretEnv = process.env.STANDALONE_EXPORT_SECRET
  if (secretEnv) {
    for (const file of listFiles(outDir)) {
      assert.ok(
        !fs.readFileSync(file, "utf8").includes(secretEnv),
        `${path.relative(outDir, file)} embeds environment value`
      )
    }
  }
})

test("unknown format: export is aborted and no package is written", () => {
  resetWork()
  const outDir = path.join(WORK, "bad-format")
  assert.throws(
    () =>
      exportStandalonePackage(outDir, {
        entries: [
          {
            name: "bad",
            schema: readJson(path.join(FIXTURES, "unknown-format.schema.json")),
          },
        ],
      }),
    /unknown format/
  )
  assert.ok(!fs.existsSync(outDir), "no output directory on failure")
})

test("custom keyword without code: reported unsupported, no package is written", () => {
  resetWork()
  const outDir = path.join(WORK, "bad-keyword")
  // A "validate" keyword is runtime-only: it cannot generate standalone code.
  const customAjv = new Ajv({code: {source: true}, strict: false})
  customAjv.addKeyword({keyword: "x-even", validate: (_schema, data) => data % 2 === 0})
  const schema = {
    type: "object",
    properties: {x: {type: "number", "x-even": true}},
  }
  assert.throws(
    () =>
      exportStandalonePackage(outDir, {
        ajv: customAjv,
        entries: [{name: "kw", schema}],
      }),
    /not supported/
  )
  assert.ok(!fs.existsSync(outDir), "no output directory on unsupported keyword")
})

test("CLI: produces the same portable package", () => {
  resetWork()
  const outDir = path.join(WORK, "cli-pkg")
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "export-standalone.js"),
      "--config",
      path.join(FIXTURES, "export.config.json"),
      "--out",
      outDir,
    ],
    {stdio: "pipe", cwd: ROOT}
  )
  const manifest = readJson(path.join(outDir, "package.json"))
  const validators = loadValidators(outDir, manifest.standaloneExports)
  runComparison("cli", validators)
})

test("entry file names are de-collided and never take reserved names", () => {
  resetWork()
  const outDir = path.join(WORK, "names")
  const result = exportStandalonePackage(outDir, {
    entries: [
      {name: "ping", schema: {type: "string"}},
      {name: "PING", schema: {type: "number"}}, // case-insensitive collision
      {name: "ping/v2", schema: {type: "boolean"}}, // sanitised to ping_v2
    ],
  })
  const files = Object.values(result.entryFiles)
  assert.strictEqual(new Set(files.map((f) => f.toLowerCase())).size, files.length)
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(outDir, f)), `${f} exists`)
    assert.ok(!f.includes("/") && !f.includes("\\"), "entry files stay at package root")
  }
})

test("missing $ref: export is aborted and no package is written", () => {
  resetWork()
  const outDir = path.join(WORK, "missing-ref")
  assert.throws(
    () =>
      exportStandalonePackage(outDir, {
        entries: [{name: "broken", schema: {$ref: "does-not-exist.schema.json#/x"}}],
      }),
    /can't resolve reference/
  )
  assert.ok(!fs.existsSync(outDir), "no output directory on missing ref")
})

function loadValidators(dir, entryFiles) {
  return {
    user: require(path.join(dir, entryFiles.user)),
    order: require(path.join(dir, entryFiles.order)),
  }
}

fs.rmSync(WORK, {recursive: true, force: true})
if (failures) {
  console.error(`\n${failures} acceptance test(s) failed`)
  process.exit(1)
}
console.log("\nall standalone export acceptance tests passed")
