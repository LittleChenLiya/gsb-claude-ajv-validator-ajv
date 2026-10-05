import * as fs from "fs"
import * as path from "path"
import Ajv from "../ajv"
import {_} from "../compile/codegen/code"
import standaloneCode from "./index"
import type {Options} from "../core"

/**
 * Explicit standalone validator package exporter.
 *
 * Unlike `standaloneCode`, which produces a single module source string, this
 * module exports a complete, self-contained package directory: one entry file
 * per requested schema plus every runtime helper and format module the
 * generated code depends on (copied under `vendor/node_modules/`, with bare
 * `require(...)` specifiers rewritten to relative paths). The resulting package
 * can be copied to another directory and loaded without installing anything or
 * having Ajv available.
 *
 * Failure modes that cannot produce standalone code (unknown formats, custom
 * keywords/formats without source-code support, missing $ref targets) are
 * rejected before anything is written, so a half-written package is never left
 * behind.
 */

export interface StandaloneEntry {
  /** Logical entry name, also used to derive the output file name. */
  name: string
  /** Schema object. */
  schema: Record<string, unknown>
}

export interface StandaloneExportConfig {
  /** Entries to export - every entry gets its own file. */
  entries: StandaloneEntry[]
  /**
   * Shared definition schemas added (with their `$id`) before the entries are
   * compiled, so the entries can reference them via `$ref`.
   */
  schemas?: Record<string, unknown>[]
  /**
   * Ajv constructor options to compile with. Defaults enable `useDefaults` and
   * `allErrors`; `strict` stays at the Ajv default so unknown formats are
   * reported rather than silently ignored. `code.source` is always enabled.
   * Ignored when a pre-configured `ajv` instance is passed.
   */
  ajvOptions?: Options
  /**
   * Register the formats from the `ajv-formats` package (its "full" set) on
   * the compiling Ajv instance. The format module is vendored into the output.
   */
  ajvFormats?: boolean
  /**
   * Pre-configured Ajv instance (e.g. with custom keywords registered). It must
   * be constructed with `code: {source: true}`. When omitted an instance is
   * created from `ajvOptions`.
   */
  ajv?: Ajv
}

export interface StandaloneExportResult {
  /** Absolute path of the written package directory. */
  outDir: string
  /** Map of entry name to the generated entry file (relative to outDir). */
  entryFiles: {[name: string]: string}
  /** Runtime packages copied into `vendor/node_modules/`. */
  dependencies: {[name: string]: string}
}

const RESERVED_FILES = new Set(["package.json", "readme.md", "node_modules"])
const REQUIRE_RE = /require\(\s*(['"])([^'"]+)\1\s*\)/g

class ExportError extends Error {
  constructor(message: string) {
    super(`standalone export failed: ${message}`)
    this.name = "ExportError"
  }
}

interface InMemoryFile {
  // Path relative to the output directory, POSIX separators.
  relPath: string
  content: string
}

interface VendorModule {
  // Package the specifier belongs to ("ajv" or an npm package name).
  pkg: string
  // Absolute source path of the module file on the build machine.
  absPath: string
  // Destination path inside the package, POSIX separators.
  outPath: string
}

/**
 * Build the standalone package in memory and, only after every entry compiled
 * and every dependency was resolved, write it to `outDir`.
 *
 * @param {string} outDir - directory to write the package to; it must not
 * exist or be empty (it is created if absent).
 * @param {StandaloneExportConfig} config - export configuration (entries,
 * shared schemas and options).
 * @returns {StandaloneExportResult} summary of the written package: its path,
 * entries and dependencies.
 */
export function exportStandalonePackage(
  outDir: string,
  config: StandaloneExportConfig
): StandaloneExportResult {
  const built = buildPackageFiles(config)
  writePackage(outDir, built)
  return built.result
}

/** Tracks vendored modules and the packages they belong to. */
class VendorSet {
  // specifier (e.g. "ajv/dist/runtime/equal", "fast-deep-equal") -> module
  private readonly bySpec = new Map<string, VendorModule>()
  // absolute source file path -> module
  private readonly byAbs = new Map<string, VendorModule>()
  private readonly packageRoots = new Map<string, string>()

  resolve(spec: string): VendorModule & {relRequire: string} {
    const existing = this.bySpec.get(spec)
    if (existing) return this.rel(existing)

    const {pkg, subPath} = splitSpecifier(spec)
    const pkgRoot = this.findPackageRoot(pkg)
    const absPath = subPath
      ? resolveModuleFile(path.resolve(pkgRoot, subPath))
      : resolvePackageMain(pkgRoot)
    if (!isInside(pkgRoot, absPath)) {
      throw new ExportError(`cannot vendor "${spec}": file is outside of package ${pkg}`)
    }

    // Different specifier spellings (with/without ".js") resolve to one file.
    const sameFile = this.byAbs.get(absPath)
    if (sameFile) {
      this.bySpec.set(spec, sameFile)
      return this.rel(sameFile)
    }

    const outPath = ["vendor", "node_modules", pkg, path.relative(pkgRoot, absPath)]
      .join("/")
      .replace(/\\/g, "/")
    const mod: VendorModule = {pkg, absPath, outPath}
    this.bySpec.set(spec, mod)
    this.byAbs.set(absPath, mod)
    return this.rel(mod)
  }

  private rel(mod: VendorModule): VendorModule & {relRequire: string} {
    // The rewritten require uses the on-disk ".js" name so it resolves without
    // package "main"/extension lookup; it is always relative into vendor/.
    return {...mod, relRequire: `./${mod.outPath}`}
  }

  private findPackageRoot(pkg: string): string {
    const cached = this.packageRoots.get(pkg)
    if (cached) return cached
    let root: string
    if (pkg === "ajv") {
      // Always vendor the exact ajv build used to generate the code.
      root = path.resolve(__dirname, "..", "..")
    } else {
      root = path.dirname(require.resolve(`${pkg}/package.json`))
    }
    this.packageRoots.set(pkg, root)
    return root
  }

  /**
   * Read the required files, recursively vendoring their bare dependencies.
   *
   * @returns {InMemoryFile[]} in-memory files keyed by their path in the
   * output package.
   */
  collectFiles(): InMemoryFile[] {
    const files: InMemoryFile[] = []
    const done = new Set<string>()
    const queue: VendorModule[] = [...this.byAbs.values()]
    while (queue.length) {
      const mod = queue.shift() as VendorModule
      if (done.has(mod.absPath)) continue
      done.add(mod.absPath)
      const raw = fs.readFileSync(mod.absPath, "utf8")
      const content = raw.replace(REQUIRE_RE, (match, _q: string, spec: string) => {
        if (spec.startsWith(".") || spec.startsWith("/")) return match
        const dep = this.resolve(spec)
        queue.push(dep)
        return `require(${JSON.stringify(relativeRequire(mod.outPath, dep.outPath))})`
      })
      files.push({relPath: mod.outPath, content})
    }
    return files
  }

  packageVersions(): {[name: string]: string} {
    const versions: {[name: string]: string} = {}
    for (const pkg of this.packageRoots.keys()) {
      const root = this.packageRoots.get(pkg) as string
      let version: string
      if (pkg === "ajv") {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        version = (require("../../package.json") as {version: string}).version
      } else {
        version = (
          JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {version: string}
        ).version
      }
      versions[pkg] = `^${version}`
    }
    return versions
  }
}

interface BuiltFiles {
  files: InMemoryFile[]
  result: StandaloneExportResult
}

interface CompiledEntries {
  sources: {name: string; source: string}[]
  entryFiles: {[name: string]: string}
}

function buildPackageFiles(config: StandaloneExportConfig): BuiltFiles {
  if (!Array.isArray(config.entries) || config.entries.length === 0) {
    throw new ExportError("config.entries must be a non-empty array")
  }
  const ajv = createAjv(config)
  for (const schema of config.schemas || []) {
    try {
      ajv.addSchema(schema as never)
    } catch (e) {
      throw new ExportError((e as Error).message)
    }
  }

  // Compile every entry first, in memory. An error here means no output at all.
  const {sources, entryFiles} = compileEntries(config, ajv)

  // Resolve and vendor everything each entry source requires.
  const vendor = new VendorSet()
  const entryFileList: InMemoryFile[] = sources.map(({name, source}) => ({
    relPath: entryFiles[name],
    content: rewriteRequires(source, vendor),
  }))
  const vendorFiles = vendor.collectFiles()
  const dependencyVersions = vendor.packageVersions()

  const manifest = buildManifest(entryFiles, dependencyVersions)
  const readme = buildReadme(entryFiles, dependencyVersions)

  const files: InMemoryFile[] = [
    ...entryFileList,
    ...vendorFiles,
    {relPath: "package.json", content: JSON.stringify(manifest, null, 2) + "\n"},
    {relPath: "README.md", content: readme},
  ]

  rejectMachineData(files)

  return {
    files,
    result: {outDir: "", entryFiles, dependencies: dependencyVersions},
  }
}

function createAjv(config: StandaloneExportConfig): Ajv {
  if (config.ajv) {
    if (!config.ajv.opts.code.source) {
      throw new ExportError("the Ajv instance must be created with code: {source: true}")
    }
    return config.ajv
  }
  const codeFormats = config.ajvFormats
    ? _`require("ajv-formats/dist/formats").fullFormats`
    : undefined
  const ajv = new Ajv({
    useDefaults: true,
    allErrors: true,
    ...config.ajvOptions,
    code: {...config.ajvOptions?.code, source: true, formats: codeFormats},
  })
  if (config.ajvFormats) registerAjvFormats(ajv)
  return ajv
}

function compileEntries(config: StandaloneExportConfig, ajv: Ajv): CompiledEntries {
  const sources: {name: string; source: string}[] = []
  const usedFileNames = new Set<string>(RESERVED_FILES)
  const entryFiles: {[name: string]: string} = {}
  const namesSeen = new Set<string>()
  for (const entry of config.entries) {
    if (typeof entry.name != "string" || !entry.name) {
      throw new ExportError("every entry needs a non-empty name")
    }
    if (namesSeen.has(entry.name)) throw new ExportError(`duplicate entry name "${entry.name}"`)
    namesSeen.add(entry.name)
    const fileName = uniqueFileName(entry.name, usedFileNames)
    const source = compileEntrySource(ajv, entry.schema)
    sources.push({name: entry.name, source})
    entryFiles[entry.name] = fileName
  }
  return {sources, entryFiles}
}

function compileEntrySource(ajv: Ajv, schema: Record<string, unknown>): string {
  let validate
  try {
    validate = ajv.compile(schema as never)
  } catch (e) {
    throw new ExportError(unsupportedMessage((e as Error).message))
  }
  try {
    return standaloneCode(ajv, validate)
  } catch (e) {
    throw new ExportError(unsupportedMessage((e as Error).message))
  }
}

function unsupportedMessage(message: string): string {
  if (message.includes("not defined") && message.includes("formats")) {
    return `custom format without source code is not supported: ${message}`
  }
  if (message.includes("not defined")) {
    return `keyword without source code is not supported (only "code" and "macro" keywords): ${message}`
  }
  return message
}

function registerAjvFormats(ajv: Ajv): void {
  let fullFormats: {[name: string]: unknown}
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ;({fullFormats} = require("ajv-formats/dist/formats"))
  } catch (e) {
    throw new ExportError('ajvFormats is enabled but the "ajv-formats" package is not installed')
  }
  for (const [name, def] of Object.entries(fullFormats)) ajv.addFormat(name, def as never)
}

function uniqueFileName(entryName: string, used: Set<string>): string {
  const base = entryName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._-]+/, "") || "entry"
  let name = `${base}.validate.js`
  let i = 1
  while (used.has(name.toLowerCase())) name = `${base}.validate.${i++}.js`
  used.add(name.toLowerCase())
  return name
}

/**
 * Rewrite every bare/ajv `require(...)` specifier in generated source to a
 * relative path inside the vendored package, registering each dependency.
 *
 * @param {string} source - generated standalone module source.
 * @param {VendorSet} vendor - vendor set that resolves and records required
 * modules.
 * @returns {string} source with bare requires replaced by relative requires.
 */
function rewriteRequires(source: string, vendor: VendorSet): string {
  return source.replace(REQUIRE_RE, (match, _quote: string, spec: string) => {
    if (spec.startsWith(".") || spec.startsWith("/")) return match
    const mod = vendor.resolve(spec)
    return `require(${JSON.stringify(mod.relRequire)})`
  })
}

function resolveModuleFile(file: string): string {
  if (fs.existsSync(file)) return file
  if (fs.existsSync(`${file}.js`)) return `${file}.js`
  if (fs.existsSync(path.join(file, "index.js"))) return path.join(file, "index.js")
  throw new ExportError(`cannot resolve vendored module file: ${file}`)
}

function resolvePackageMain(pkgRoot: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as {
    main?: string
    module?: string
  }
  const main = pkg.main || "index.js"
  return resolveModuleFile(path.resolve(pkgRoot, main))
}

function splitSpecifier(spec: string): {pkg: string; subPath: string} {
  const parts = spec.split("/")
  if (spec.startsWith("@")) {
    if (parts.length < 2) throw new ExportError(`invalid package specifier "${spec}"`)
    return {pkg: `${parts[0]}/${parts[1]}`, subPath: parts.slice(2).join("/")}
  }
  return {pkg: parts[0], subPath: parts.slice(1).join("/")}
}

function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function relativeRequire(fromFile: string, toFile: string): string {
  let rel = path.relative(path.dirname(fromFile), toFile).replace(/\\/g, "/")
  if (!rel.startsWith(".")) rel = `./${rel}`
  return rel
}

function buildManifest(
  entryFiles: {[name: string]: string},
  dependencies: {[name: string]: string}
): Record<string, unknown> {
  const firstName = Object.keys(entryFiles)[0]
  return {
    name: "standalone-validators",
    version: "1.0.0",
    private: true,
    description: "Self-contained standalone validation functions exported from Ajv",
    main: entryFiles[firstName],
    standaloneExports: {...entryFiles},
    dependencies,
  }
}

function buildReadme(
  entryFiles: {[name: string]: string},
  dependencies: {[name: string]: string}
): string {
  const firstName = Object.keys(entryFiles)[0]
  const entries = Object.entries(entryFiles)
    .map(([name, file]) => `- ${name} -> ./${file}`)
    .join("\n")
  const deps = Object.keys(dependencies).length
    ? Object.entries(dependencies)
        .map(([name, version]) => `- ${name} ${version} (vendored under vendor/node_modules)`)
        .join("\n")
    : "- none"
  return [
    "# Standalone validators",
    "",
    "This package contains self-contained Ajv validation functions compiled at",
    "export time. It can be copied to another directory and used without Ajv or",
    "any `npm install` - all runtime helpers and format dependencies are vendored",
    "under `vendor/node_modules` and referenced by relative paths.",
    "",
    "## Entries",
    "",
    entries,
    "",
    "## Usage (Node.js, local commands)",
    "",
    "```sh",
    `node -e 'const v=require("./${entryFiles[firstName]}");console.log(v({}))'`,
    "```",
    "",
    "```js",
    `const validate = require("./${entryFiles[firstName]}")`,
    "const ok = validate(data)",
    "if (!ok) console.error(validate.errors)",
    "```",
    "",
    "Each entry is a CommonJS module that exports the validation function as both",
    "`module.exports` and `module.exports.default`.",
    "",
    "## Runtime dependencies (complete manifest)",
    "",
    deps,
    "",
    'The same dependency set is recorded in package.json ("dependencies" and',
    '"standaloneExports"). The package directory is portable: nothing outside it',
    "is loaded, and no absolute paths or environment values are embedded.",
    "",
  ].join("\n")
}

function rejectMachineData(files: InMemoryFile[]): void {
  const cwd = process.cwd().replace(/\\/g, "/").toLowerCase()
  const home = (process.env.USERPROFILE || process.env.HOME || "").replace(/\\/g, "/").toLowerCase()
  for (const file of files) {
    const content = file.content.toLowerCase()
    if (content.includes(cwd)) {
      throw new ExportError(`refusing to embed build machine path in ${file.relPath}`)
    }
    if (home && content.includes(home)) {
      throw new ExportError(`refusing to embed user home path in ${file.relPath}`)
    }
  }
}

function writePackage(outDir: string, built: BuiltFiles): void {
  const target = path.resolve(outDir)
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) {
      throw new ExportError(`output path exists and is not a directory: ${target}`)
    }
    if (fs.readdirSync(target).length > 0) {
      throw new ExportError(`output directory is not empty: ${target}`)
    }
  }
  fs.mkdirSync(target, {recursive: true})
  for (const file of built.files) {
    const dest = path.join(target, ...file.relPath.split("/"))
    fs.mkdirSync(path.dirname(dest), {recursive: true})
    fs.writeFileSync(dest, file.content)
  }
  built.result.outDir = target
}
