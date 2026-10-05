import type Ajv from "../dist/core"
import _Ajv from "./ajv"
import standalonePackage from "../dist/standalone/package"
import * as assert from "assert"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"

describe("standalone package export", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajv-pkg-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  function makeAjv(opts: Record<string, unknown> = {}): Ajv {
    return new _Ajv({code: {source: true}, ...opts})
  }

  it("should generate a package with two entries sharing defs", () => {
    const userSchema = {
      $id: "user.json",
      type: "object",
      properties: {
        name: {type: "string", minLength: 2},
      },
      required: ["name"],
    }
    const infoSchema = {
      $id: "info.json",
      type: "object",
      properties: {
        author: {$ref: "user.json"},
      },
      required: ["author"],
    }

    const ajv = makeAjv()
    ajv.addSchema(userSchema)
    ajv.addSchema(infoSchema)

    const outDir = path.join(tmpDir, "pkg")
    standalonePackage(ajv, {user: "user.json", info: "info.json"}, {outDir})

    assert.strictEqual(fs.existsSync(path.join(outDir, "defs.js")), true)
    assert.strictEqual(fs.existsSync(path.join(outDir, "entries", "user.js")), true)
    assert.strictEqual(fs.existsSync(path.join(outDir, "entries", "info.js")), true)
    assert.strictEqual(fs.existsSync(path.join(outDir, "package.json")), true)

    const user = require(path.join(outDir, "entries", "user"))
    const info = require(path.join(outDir, "entries", "info"))

    assert.strictEqual(user({name: "John"}), true)
    assert.strictEqual(user({}), false)
    assert.strictEqual(info({author: {name: "John"}}), true)
    assert.strictEqual(info({}), false)
  })

  it("should validate correctly after moving the package to another directory", () => {
    const schema = {
      $id: "test.json",
      type: "object",
      properties: {
        name: {type: "string", minLength: 2},
      },
      required: ["name"],
    }

    const ajv = makeAjv()
    ajv.addSchema(schema)

    const outDir = path.join(tmpDir, "pkg")
    standalonePackage(ajv, {test: "test.json"}, {outDir})

    const movedDir = path.join(tmpDir, "moved-pkg")
    fs.renameSync(outDir, movedDir)

    const test = require(path.join(movedDir, "entries", "test"))
    assert.strictEqual(test({name: "John"}), true)
    assert.strictEqual(test({name: "J"}), false)
    assert.strictEqual(test({}), false)
  })

  it("should produce the same validation results as normal Ajv", () => {
    const schema = {
      $id: "test.json",
      type: "object",
      properties: {
        name: {type: "string", minLength: 2},
        email: {type: "string", format: "email"},
        role: {type: "string", default: "user"},
      },
      required: ["name"],
    }

    const ajv = makeAjv({useDefaults: true})
    ajv.addFormat("email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/)
    ajv.addSchema(schema)

    const outDir = path.join(tmpDir, "pkg")
    standalonePackage(ajv, {test: "test.json"}, {outDir})

    const normal = ajv.getSchema("test.json")!
    const exported = require(path.join(outDir, "entries", "test"))

    const testCases = [
      {name: "John"},
      {name: "John", email: "john@example.com"},
      {name: "J"},
      {},
      {name: "John", email: "bad"},
      {name: "John", role: "admin"},
    ]

    for (const data of testCases) {
      const d1 = JSON.parse(JSON.stringify(data))
      const d2 = JSON.parse(JSON.stringify(data))
      const r1 = normal(d1)
      const r2 = exported(d2)
      assert.strictEqual(r1, r2, "validation result mismatch for " + JSON.stringify(data))
      assert.deepStrictEqual(d1, d2, "default filling mismatch for " + JSON.stringify(data))
    }
  })

  it("should not write a package when an unknown format is used", () => {
    const ajv = makeAjv()
    ajv.addSchema({
      $id: "test.json",
      type: "object",
      properties: {
        email: {type: "string", format: "email"},
      },
    })

    const outDir = path.join(tmpDir, "pkg")
    assert.throws(() => {
      standalonePackage(ajv, {test: "test.json"}, {outDir})
    }, /unknown format/)

    assert.strictEqual(fs.existsSync(outDir), false)
  })

  it("should not write a package when an unsupported keyword is used", () => {
    const ajv = makeAjv()
    ajv.addKeyword({
      keyword: "isEven",
      type: "number",
      compile: function () {
        return function (data: number) {
          return data % 2 === 0
        }
      },
    })
    ajv.addSchema({
      $id: "test.json",
      type: "object",
      properties: {
        value: {type: "number", isEven: true},
      },
    })

    const outDir = path.join(tmpDir, "pkg")
    assert.throws(() => {
      standalonePackage(ajv, {test: "test.json"}, {outDir})
    }, /unsupported custom keywords/)

    assert.strictEqual(fs.existsSync(outDir), false)
  })

  it("should support function formats", () => {
    const ajv = makeAjv()
    ajv.addFormat("even", {
      type: "number",
      validate: (n: number) => n % 2 === 0,
    })
    ajv.addSchema({
      $id: "test.json",
      type: "object",
      properties: {
        count: {type: "number", format: "even"},
      },
    })

    const outDir = path.join(tmpDir, "pkg")
    standalonePackage(ajv, {test: "test.json"}, {outDir})

    const test = require(path.join(outDir, "entries", "test"))
    assert.strictEqual(test({count: 2}), true)
    assert.strictEqual(test({count: 3}), false)
    assert.strictEqual(test({count: 0}), true)
  })

  it("should support RegExp formats", () => {
    const ajv = makeAjv()
    ajv.addFormat("username", /[a-z][a-z0-9_]*/i)
    ajv.addSchema({
      $id: "test.json",
      type: "object",
      properties: {
        username: {type: "string", format: "username"},
      },
    })

    const outDir = path.join(tmpDir, "pkg")
    standalonePackage(ajv, {test: "test.json"}, {outDir})

    const test = require(path.join(outDir, "entries", "test"))
    assert.strictEqual(test({username: "john"}), true)
    assert.strictEqual(test({username: "123"}), false)
    assert.strictEqual(test({}), true)
  })

  it("should not write absolute paths or environment values", () => {
    const schema = {
      $id: "test.json",
      type: "object",
      properties: {
        name: {type: "string", minLength: 2},
      },
      required: ["name"],
    }

    const ajv = makeAjv()
    ajv.addSchema(schema)

    const outDir = path.join(tmpDir, "pkg")
    standalonePackage(ajv, {test: "test.json"}, {outDir})

    const defsCode = fs.readFileSync(path.join(outDir, "defs.js"), "utf8")
    assert.strictEqual(defsCode.includes("ajv/dist"), false, "should not reference ajv/dist")
    assert.strictEqual(defsCode.includes(__dirname), false, "should not include absolute paths")
  })

  it("should generate a package manifest with entries, runtime, and formats", () => {
    const ajv = makeAjv()
    ajv.addFormat("even", {
      type: "number",
      validate: (n: number) => n % 2 === 0,
    })
    ajv.addSchema({
      $id: "test.json",
      type: "object",
      properties: {
        count: {type: "number", format: "even"},
      },
    })

    const outDir = path.join(tmpDir, "pkg")
    standalonePackage(ajv, {test: "test.json"}, {outDir})

    const pkg = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf8"))
    assert.strictEqual(pkg.main, "defs.js")
    assert.strictEqual(pkg.entries.test, "entries/test.js")
    assert.strictEqual(pkg.formats.even, "formats/even.js")
    assert.strictEqual(typeof pkg.scripts.validate, "string")
  })

  it("should prevent filename collisions", () => {
    const ajv = makeAjv()
    ajv.addSchema({
      $id: "test.json",
      type: "object",
      properties: {
        name: {type: "string"},
      },
    })

    const outDir = path.join(tmpDir, "pkg")
    standalonePackage(ajv, {test: "test.json"}, {outDir})
    standalonePackage(ajv, {test: "test.json"}, {outDir})

    const test = require(path.join(outDir, "entries", "test"))
    assert.strictEqual(test({name: "John"}), true)
  })

  it("should throw when code.source is not enabled", () => {
    const ajv = new _Ajv()
    ajv.addSchema({
      $id: "test.json",
      type: "object",
    })

    const outDir = path.join(tmpDir, "pkg")
    assert.throws(() => {
      standalonePackage(ajv, {test: "test.json"}, {outDir})
    }, /code.source/)
  })
})
