import type Ajv from "../core"
import type {AnyValidateFunction, AnySchema, SourceCode} from "../types"
import type {SchemaEnv} from "../compile"
import type {ScopeValueSets, ValueScopeName} from "../compile/codegen/scope"
import {nil, Code, _Code} from "../compile/codegen/code"
import standaloneCode from "."
import * as fs from "fs"
import * as path from "path"

export interface StandalonePackageOptions {
  outDir: string
  esm?: boolean
  es5?: boolean
  package?: Record<string, unknown>
  clean?: boolean
}

interface Closure {
  validators: Map<string, {name: ValueScopeName; env: SchemaEnv; source: SourceCode}>
  schemas: Map<string, {name: ValueScopeName; schema: unknown}>
  formats: Map<string, {name: ValueScopeName; def: unknown}>
  helpers: Map<string, ValueScopeName>
  unsupportedKeywords: string[]
  unknownFormats: string[]
  missingRefs: string[]
}

export function standalonePackage(
  ajv: Ajv,
  entries: Record<string, string | AnySchema | AnyValidateFunction>,
  options: StandalonePackageOptions
): void {
  if (!ajv.opts.code.source) {
    throw new Error("standalonePackage: ajv instance must have code.source option")
  }

  const {outDir, esm = false} = options

  const entryValidators: Record<string, AnyValidateFunction> = {}
  for (const name in entries) {
    const v = getValidate(ajv, entries[name])
    if (v) entryValidators[name] = v
  }

  if (Object.keys(entryValidators).length === 0) {
    throw new Error("standalonePackage: no valid entries provided")
  }

  const closure = collectClosure(entryValidators)
  checkUnsupported(closure)
  const modules = renderModules(ajv, entryValidators, closure, {esm})
  writePackage(outDir, modules, options)
}

function getValidate(ajv: Ajv, entry: string | AnySchema | AnyValidateFunction): AnyValidateFunction | undefined {
  if (typeof entry === "function") return entry
  if (typeof entry === "string") return ajv.getSchema(entry)
  return ajv.compile(entry)
}

function collectClosure(entries: Record<string, AnyValidateFunction>): Closure {
  const closure: Closure = {
    validators: new Map(),
    schemas: new Map(),
    formats: new Map(),
    helpers: new Map(),
    unsupportedKeywords: [],
    unknownFormats: [],
    missingRefs: [],
  }

  const visited = new Set<ValueScopeName>()
  const queue: ValueScopeName[] = []

  for (const name in entries) {
    const v = entries[name]
    if (v.source) collectScopeValues(v.source.scopeValues)
  }

  function collectScopeValues(scopeValues: ScopeValueSets): void {
    for (const prefix in scopeValues) {
      const names = scopeValues[prefix]
      if (!names) continue
      for (const name of names) {
        if (visited.has(name)) continue
        visited.add(name)
        queue.push(name)
      }
    }
  }

  while (queue.length > 0) {
    const name = queue.shift()!
    processScopeValue(name)
  }

  function processScopeValue(name: ValueScopeName): void {
    const {prefix, value} = name
    if (!value) return

    switch (prefix) {
      case "validate":
        processValidate(name, value.ref as AnyValidateFunction)
        break
      case "wrapper":
      case "root":
        processWrapper(name, value.ref as SchemaEnv)
        break
      case "schema":
        closure.schemas.set(name.str, {name, schema: value.ref})
        break
      case "formats":
        processFormat(name, value)
        break
      case "keyword":
        if (!value.code && typeof value.ref === "function") {
          closure.unsupportedKeywords.push(name.str)
        }
        break
      default:
        processHelper(name, value)
        break
    }
  }

  function processValidate(name: ValueScopeName, v: AnyValidateFunction): void {
    if (v.source) {
      closure.validators.set(name.str, {name, env: v.schemaEnv, source: v.source})
      collectScopeValues(v.source.scopeValues)
    } else {
      closure.missingRefs.push(name.str)
    }
  }

  function processWrapper(name: ValueScopeName, env: SchemaEnv): void {
    if (env.validate?.source) {
      closure.validators.set(name.str, {name, env, source: env.validate.source})
      collectScopeValues(env.validate.source.scopeValues)
    } else {
      closure.missingRefs.push(name.str)
    }
  }

  function processFormat(name: ValueScopeName, value: NonNullable<ValueScopeName["value"]>): void {
    const fmtName = String(value.key ?? name.str)
    if (value.code || value.ref instanceof RegExp) {
      closure.formats.set(fmtName, {name, def: value.ref})
    } else if (value.ref === true) {
      // no-op format
    } else if (value.ref && (typeof value.ref === "object" || typeof value.ref === "function")) {
      closure.formats.set(fmtName, {name, def: value.ref})
    } else {
      closure.unknownFormats.push(fmtName)
    }
  }

  function processHelper(name: ValueScopeName, value: NonNullable<ValueScopeName["value"]>): void {
    const code = value.code as unknown
    if (!code) return
    const codeStr = typeof code === "string" ? code : String(code)
    const match = codeStr.match(/require\("ajv\/dist\/runtime\/([^"]+)"\)/)
    if (match) closure.helpers.set(match[1], name)
  }

  return closure
}

function checkUnsupported(closure: Closure): void {
  const errors: string[] = []
  if (closure.unsupportedKeywords.length > 0) {
    errors.push("unsupported custom keywords (cannot generate code): " + closure.unsupportedKeywords.join(", "))
  }
  if (closure.unknownFormats.length > 0) {
    errors.push("unknown formats: " + closure.unknownFormats.join(", "))
  }
  if (closure.missingRefs.length > 0) {
    errors.push("missing references: " + closure.missingRefs.join(", "))
  }
  if (errors.length > 0) {
    throw new Error("standalonePackage: cannot generate package:\n  " + errors.join("\n  "))
  }
}

function renderModules(
  ajv: Ajv,
  entryValidators: Record<string, AnyValidateFunction>,
  closure: Closure,
  opts: {esm: boolean}
): Record<string, string> {
  const modules: Record<string, string> = {}

  const allValidators: Record<string, AnyValidateFunction> = Object.assign({}, entryValidators)
  for (const [name, {source}] of closure.validators) {
    const v = findValidateFunction(ajv, source)
    if (v) allValidators[name] = v
  }

  const restore = rewriteScopeCodes(closure, ".")

  let defsCode: string
  try {
    defsCode = standaloneCode(ajv, allValidators)
  } finally {
    restore()
  }

  modules["defs.js"] = defsCode

  for (const name in entryValidators) {
    modules["entries/" + safeFileName(name) + ".js"] = renderEntryModule(name, opts.esm)
  }

  for (const [name, {def}] of closure.formats) {
    // Skip RegExp formats - they are inlined in the generated code
    if (def instanceof RegExp) continue
    modules["formats/" + safeFileName(name) + ".js"] = renderFormatModule(def, opts.esm)
  }

  for (const [name] of closure.helpers) {
    modules["runtime/" + name + ".js"] = renderRuntimeModule(name)
  }

  return modules
}

function findValidateFunction(ajv: Ajv, source: SourceCode): AnyValidateFunction | undefined {
  for (const id in ajv.schemas) {
    const env = ajv.schemas[id]
    if (env && env.validate && env.validate.source === source) return env.validate
  }
  return undefined
}

function rewriteScopeCodes(closure: Closure, relPath: string): () => void {
  const originalCodes = new Map<ValueScopeName, Code | undefined>()

  const allScopeValues: ValueScopeName[] = []
  for (const [, {name}] of closure.validators) allScopeValues.push(name)
  for (const [, {name}] of closure.schemas) allScopeValues.push(name)
  for (const [, {name}] of closure.formats) allScopeValues.push(name)
  for (const [, name] of closure.helpers) allScopeValues.push(name)

  for (const name of allScopeValues) {
    if (!name.value) continue
    originalCodes.set(name, name.value.code)

    const {code} = name.value
    if (!code || code === nil) continue

    const codeStr = String(code)

    const helperMatch = codeStr.match(/require\("ajv\/dist\/runtime\/([^"]+)"\)/)
    if (helperMatch) {
      name.value.code = new _Code('require("' + relPath + '/runtime/' + helperMatch[1] + '").default')
    }

    const formatMatch = codeStr.match(
      /require\("ajv-formats\/dist\/formats"\)\.(fullFormats|fastFormats)\.(\w+)/
    )
    if (formatMatch) {
      name.value.code = new _Code('require("' + relPath + '/formats/' + formatMatch[2] + '")')
    }
  }

  // Handle function/object formats that have no code (need to be written as modules)
  for (const [fmtName, {name, def}] of closure.formats) {
    if (def instanceof RegExp) continue
    if (!name.value) continue
    if (name.value.code) continue // already has code (ajv-formats or inlined)
    originalCodes.set(name, name.value.code)
    name.value.code = new _Code('require("' + relPath + '/formats/' + safeFileName(fmtName) + '")')
  }

  return () => {
    for (const [name, code] of originalCodes) {
      if (name.value) name.value.code = code
    }
  }
}

function renderEntryModule(name: string, esm: boolean): string {
  if (esm) {
    return "import { " + name + ' } from "../defs";\nexport default ' + name + ";\n"
  }
  return (
    '"use strict";\n' +
    'const defs = require("../defs");\n' +
    "module.exports = defs[" + JSON.stringify(name) + "];\n" +
    "module.exports.default = defs[" + JSON.stringify(name) + "];\n"
  )
}

function renderFormatModule(def: unknown, esm: boolean): string {
  const json = serializeValue(def)
  if (esm) {
    return "const def = " + json + ";\nexport default def;\n"
  }
  return '"use strict";\nmodule.exports = ' + json + ";\nmodule.exports.default = module.exports;\n"
}

function renderRuntimeModule(name: string): string {
  const distPath = path.join(__dirname, "..", "runtime", name + ".js")
  if (fs.existsSync(distPath)) {
    let code = fs.readFileSync(distPath, "utf8")
    code = code.replace(
      new RegExp('require\\("ajv/dist/runtime/' + name + '"\\)', "g"),
      'require("./' + name + '")'
    )
    return code
  }
  throw new Error("standalonePackage: runtime helper \"" + name + "\" not found at " + distPath)
}

function serializeValue(x: unknown, seen: Set<unknown> = new Set()): string {
  if (x === null || x === undefined) return JSON.stringify(x)
  if (x instanceof RegExp) return x.toString()
  if (typeof x === "function") return x.toString()
  if (typeof x === "object") {
    if (seen.has(x)) return "undefined"
    seen.add(x)
    if (Array.isArray(x)) {
      return "[" + x.map((v) => serializeValue(v, seen)).join(", ") + "]"
    }
    const parts: string[] = []
    for (const key in x) {
      if (Object.prototype.hasOwnProperty.call(x, key)) {
        parts.push(JSON.stringify(key) + ": " + serializeValue((x as Record<string, unknown>)[key], seen))
      }
    }
    return "{" + parts.join(", ") + "}"
  }
  return JSON.stringify(x)
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function writePackage(
  outDir: string,
  modules: Record<string, string>,
  options: StandalonePackageOptions
): void {
  const files: Record<string, string> = {}
  const usedNames = new Set<string>()
  for (const relPath in modules) {
    let finalPath = relPath
    const ext = path.extname(relPath)
    const base = path.basename(relPath, ext)
    const dir = path.dirname(relPath)
    let counter = 1
    while (usedNames.has(finalPath)) {
      finalPath = path.join(dir, base + "_" + counter + ext)
      counter++
    }
    usedNames.add(finalPath)
    files[finalPath] = modules[relPath]
  }

  const tempDir = outDir + ".tmp-" + process.pid
  try {
    fs.rmSync(tempDir, {recursive: true, force: true})
    for (const relPath in files) {
      const fullPath = path.join(tempDir, relPath)
      fs.mkdirSync(path.dirname(fullPath), {recursive: true})
      fs.writeFileSync(fullPath, files[relPath])
    }
    fs.writeFileSync(path.join(tempDir, "package.json"), renderPackageJson(files, options))
    fs.rmSync(outDir, {recursive: true, force: true})
    fs.renameSync(tempDir, outDir)
  } finally {
    fs.rmSync(tempDir, {recursive: true, force: true})
  }
}

function renderPackageJson(files: Record<string, string>, options: StandalonePackageOptions): string {
  const entries: Record<string, string> = {}
  const runtime: Record<string, string> = {}
  const formats: Record<string, string> = {}

  for (const relPath in files) {
    if (relPath.startsWith("entries/")) {
      const name = path.basename(relPath, ".js")
      entries[name] = relPath
    } else if (relPath.startsWith("runtime/")) {
      const name = path.basename(relPath, ".js")
      runtime[name] = relPath
    } else if (relPath.startsWith("formats/")) {
      const name = path.basename(relPath, ".js")
      formats[name] = relPath
    }
  }  const pkg: Record<string, unknown> = {
    name: "standalone-validator-package",
    version: "1.0.0",
    description: "Standalone validator package generated by Ajv",
    main: "defs.js",
    files: ["defs.js", "entries/", "formats/", "runtime/"],
    scripts: {
      validate: "node validate.js",
    },
    entries,
    runtime,
    formats,
  }

  if (options.package) {
    for (const key in options.package) {
      pkg[key] = options.package[key]
    }
  }

  return JSON.stringify(pkg, null, 2) + "\n"
}

export default standalonePackage
