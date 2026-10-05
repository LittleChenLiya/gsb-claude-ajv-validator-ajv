# Standalone validator package export

[[toc]]

While [standalone validation code](./standalone.md) produces a single source
string that still assumes the `ajv` package is resolvable at runtime, Ajv also
provides an **explicit package exporter**: given a small set of entry schemas
it writes a complete, self-contained package directory that can be copied to
another machine or directory and loaded immediately - without running
`npm install` and without Ajv being present.

The exporter is in `lib/standalone/package.ts`
(`ajv/dist/standalone/package` after build), with a small Node.js CLI wrapper
in `scripts/export-standalone.js`.

## What the output package contains

For every entry schema a separate CommonJS file (`<name>.validate.js`) is
written. The package directory also contains:

- `vendor/node_modules/ajv/dist/runtime/*` - only the Ajv runtime helpers the
  generated code actually `require`s (e.g. `ucs2length`, `equal`, `uri`).
- `vendor/node_modules/ajv-formats/dist/formats.js` - vendored when an
  `ajv-formats` format is used (`ajvFormats: true`).
- All bare `require(...)` specifiers are rewritten to **relative paths** inside
  the package, so nothing outside the directory is loaded.
- `package.json` with:
  - `"standaloneExports"` - entry name to file map,
  - `"dependencies"` - the complete manifest of vendored runtime packages
    (name and version range),
  - `"main"` - the first entry.
- `README.md` - the list of entries, Node.js one-liner commands and the
  dependency manifest.

Shared definition schemas (added via `schemas`) are compiled into each entry
that references them, the same way `standaloneCode` inlines referenced
validators - the two entries therefore "share" the same `$defs` without any
external schema file.

## Usage

### Library API

```javascript
const path = require("path")
const {exportStandalonePackage} = require("ajv/dist/standalone/package")

const result = exportStandalonePackage(path.join(__dirname, "validators-out"), {
  ajvFormats: true, // registers the ajv-formats full format set
  schemas: [
    // shared schemas must have an $id - entries reference them via $ref
    {$id: "defs.schema.json", $defs: {id: {type: "integer", minimum: 1}}},
  ],
  entries: [
    {name: "user", schema: require("./user.schema.json")},
    {name: "order", schema: require("./order.schema.json")},
  ],
  // optional Ajv options; code.source is forced on and useDefaults defaults on
  ajvOptions: {allErrors: true},
})
console.log(result.entryFiles, result.dependencies)
```

A pre-configured `Ajv` instance (created with `code: {source: true}`, e.g. with
custom keywords) can be passed as `ajv` instead of `ajvOptions`.

### CLI

```sh
node scripts/export-standalone.js \
  --config spec/extras/standalone-export/export.config.json \
  --out .standalone-package
```

The config JSON uses paths relative to the config file:

```json
{
  "ajvFormats": true,
  "ajvOptions": {"allErrors": true},
  "schemas": ["./defs.schema.json"],
  "entries": [
    {"name": "user", "schema": "./user.schema.json"},
    {"name": "order", "schema": "./order.schema.json"}
  ]
}
```

Run `node scripts/export-standalone.js --help` for all flags.

### Loading the exported package

After copying the output directory anywhere:

```sh
node -e 'const v=require("./user.validate.js");console.log(v({}))'
```

```javascript
const validateUser = require("./user.validate.js")
const validateOrder = require("./order.validate.js")
if (!validateUser(data)) console.error(validateUser.errors)
```

## Guarantees and limitations

- The whole package is built **in memory first**. A missing `$ref`, an unknown
  format, or a custom keyword/format that cannot emit standalone code aborts the
  export with an error **before any file is written** - there is never a
  half-written package.
- Only code-generation keywords are supported, as with `standaloneCode`:
  `code` and `macro` keywords. Runtime-only `validate`/`compile` keywords and
  custom function formats without a source-code snippet are reported as
  unsupported (`... is not supported ...`).
- An unknown format (e.g. `"format": "zz-unknown"`) is an error by default
  (strict mode), so no package is generated for it. Register the format or pass
  `ajvOptions.strict: false` if it should be ignored.
- Entry file names are derived from entry names, sanitized and de-collided
  (`foo.validate.js`, `foo.validate.1.js`, ...); they never overwrite
  `package.json`, `README.md` or each other. The output directory itself must
  not exist or must be empty.
- The exported validators behave exactly like the validators compiled by the
  original Ajv instance - including default filling (`useDefaults`, enabled by
  default): validity, errors and mutated data are identical.
- No absolute path of the build machine, user home directory or process
  environment value is written into the package.
- Only the small schema set you pass is built; only the runtime helpers that
  are referenced are vendored.

## Acceptance test

The fixtures under `spec/extras/standalone-export/` and
`spec/extras/standalone-export/acceptance.js` compile two entries sharing a
`defs` schema, copy the result to another directory, and assert identical
results to the original Ajv compilation (including `useDefaults`), plus the
unknown-format / unsupported-keyword / portability cases.

```sh
npm run standalone:acceptance
```
