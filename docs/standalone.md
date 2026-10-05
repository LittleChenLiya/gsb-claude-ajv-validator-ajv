# Standalone validation code

[[toc]]

Ajv supports generating standalone validation functions from JSON Schemas at compile/build time. These functions can then be used during runtime to do validation without initialising Ajv. It is useful for several reasons:

- to reduce the browser bundle size - Ajv is not included in the bundle (although if you have a large number of schemas the bundle can become bigger - when the total size of generated validation code is bigger than Ajv code).
- to reduce the start-up time - the validation and compilation of schemas will happen during build time.
- to avoid dynamic code evaluation with Function constructor (used for schema compilation) - when it is prohibited by the browser page [Content Security Policy](./security.md#content-security-policy).

This functionality in Ajv v7 supersedes the deprecated package ajv-pack that can be used with Ajv v6. All schemas, including those with recursive references, formats and user-defined keywords are supported, with few [limitations](#configuration-and-limitations).

## Two-step process 

The **first step** is to **generate** the standalone validation function code. This is done at compile/build time of your project and the output is a generated JS file. The **second step** is to **use** the generated JS validation function.

There are two methods to generate the code, using either the Ajv CLI or the Ajv JS library. There are also a few different options that can be passed when generating code. Below is just a highlight of a few options:

- Set the `code.source` (JS) value to true or use the `compile` (CLI) command to generate standalone code.
- The standalone code can be generated in either ES5 or ES6, it defaults to ES6. Set the `code.es5` (JS) value to true or pass the `--code-es5` (CLI) flag to true if you want ES5 code.
- The standalone code can be generated in either CJS (module.export & require) or ESM (exports & import), it defaults to CJS. Set the `code.esm` (JS) value to true or pass the `--code-esm` (CLI) flag if you want ESM exported code.

Note that the way the function is exported, differs if you are exporting a single or multiple schemas. See examples below.

### Generating function(s) using CLI

In most cases you would use this functionality via [ajv-cli](https://github.com/ajv-validator/ajv-cli) (>= 4.0.0) to generate the standalone code that exports the validation function. See [ajv-cli](https://github.com/ajv-validator/ajv-cli#compile-schemas) docs and the [cli options](https://github.com/ajv-validator/ajv-cli#ajv-options) for additional information.

#### Using the defaults - ES6 and CJS exports
```sh
npm install -g ajv-cli
ajv compile -s schema.json -o validate_schema.js
```

### Generating using the JS library

Install the package, version >= v7.0.0: 
```sh
npm install ajv
```

#### Generating functions(s) for a single schema using the JS library - ES6 and CJS exports

```javascript
const fs = require("fs")
const path = require("path")
const Ajv = require("ajv")
const standaloneCode = require("ajv/dist/standalone").default

const schema = {
  $id: "https://example.com/bar.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    bar: {type: "string"},
  },
  "required": ["bar"]
}

// The generated code will have a default export:
// `module.exports = <validateFunctionCode>;module.exports.default = <validateFunctionCode>;`
const ajv = new Ajv({code: {source: true}})
const validate = ajv.compile(schema)
let moduleCode = standaloneCode(ajv, validate)

// Now you can write the module code to file
fs.writeFileSync(path.join(__dirname, "../consume/validate-cjs.js"), moduleCode)
```

#### Generating functions(s) for multiple schemas using the JS library - ES6 and CJS exports

```javascript
const fs = require("fs")
const path = require("path")
const Ajv = require("ajv")
const standaloneCode = require("ajv/dist/standalone").default

const schemaFoo = {
  $id: "#/definitions/Foo",
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    foo: {"$ref": "#/definitions/Bar"}
  }
}
const schemaBar = {
  $id: "#/definitions/Bar",
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    bar: {type: "string"},
  },
  "required": ["bar"]
}

// For CJS, it generates an exports array, will generate
// `exports["#/definitions/Foo"] = ...;exports["#/definitions/Bar"] = ... ;`
const ajv = new Ajv({schemas: [schemaFoo, schemaBar], code: {source: true}})
let moduleCode = standaloneCode(ajv)

// Now you can write the module code to file
fs.writeFileSync(path.join(__dirname, "../consume/validate-cjs.js"), moduleCode)
```

#### Generating functions(s) for multiple schemas using the JS library - ES6 and ESM exports

```javascript
const fs = require("fs")
const path = require("path")
const Ajv = require("ajv")
const standaloneCode = require("ajv/dist/standalone").default

const schemaFoo = {
  $id: "#/definitions/Foo",
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    foo: {"$ref": "#/definitions/Bar"}
  }
}
const schemaBar = {
  $id: "#/definitions/Bar",
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    bar: {type: "string"},
  },
  "required": ["bar"]
}

// For ESM, the export name needs to be a valid export name, it can not be `export const #/definitions/Foo = ...;` so we
// need to provide a mapping between a valid name and the $id field. Below will generate
// `export const Foo = ...;export const Bar = ...;`
// This mapping would not have been needed if the `$ids` was just `Bar` and `Foo` instead of `#/definitions/Foo`
// and `#/definitions/Bar` respectfully
const ajv = new Ajv({schemas: [schemaFoo, schemaBar], code: {source: true, esm: true}})
let moduleCode = standaloneCode(ajv, {
  "Foo": "#/definitions/Foo",
  "Bar": "#/definitions/Bar"
})

// Now you can write the module code to file
fs.writeFileSync(path.join(__dirname, "../consume/validate-esm.mjs"), moduleCode)
```

::: warning ESM name mapping
The ESM version only requires the mapping if the ids are not valid export names. If the $ids were just the
`Foo` and `Bar` instead of `#/definitions/Foo` and `#/definitions/Bar` then the mapping would not be needed.
:::


## Using the validation function(s)

### Validating a single schemas using the JS library - ES6 and CJS

```javascript
const Bar = require('./validate-cjs')

const barPass = {
    bar: "something"
}

const barFail = {
    // bar: "something" // <= empty/omitted property that is required
}

let validateBar = Bar
if (!validateBar(barPass))
  console.log("ERRORS 1:", validateBar.errors) //Never reaches this because valid

if (!validateBar(barFail))
  console.log("ERRORS 2:", validateBar.errors) //Errors array gets logged
```

### Validating multiple schemas using the JS library - ES6 and CJS

```javascript
const validations = require('./validate-cjs')

const fooPass = {
  foo: {
    bar: "something"
  }
}

const fooFail = {
  foo: {
    // bar: "something" // <= empty/omitted property that is required
  }
}

let validateFoo = validations["#/definitions/Foo"];
if (!validateFoo(fooPass))
  console.log("ERRORS 1:", validateFoo.errors); //Never reaches this because valid

if (!validateFoo(fooFail))
  console.log("ERRORS 2:", validateFoo.errors); //Errors array gets logged

```

### Validating multiple schemas using the JS library - ES6 and ESM

```javascript
import {Foo, Bar} from './validate-multiple-esm.mjs';

const fooPass = {
  foo: {
    bar: "something"
  }
}

const fooFail = {
  foo: {
    // bar: "something" // bar: "something" <= empty properties
  }
}

let validateFoo = Foo;
if (!validateFoo(fooPass))
  console.log("ERRORS 1:", validateFoo.errors); //Never reaches here because valid

if (!validateFoo(fooFail))
  console.log("ERRORS 2:", validateFoo.errors); //Errors array gets logged
```


### Requirement at runtime

One of the main reason for using the standalone mode is to start applications faster to avoid runtime schema compilation. 

The standalone generated functions still has a dependency on the Ajv. Specifically on the code in the [runtime](https://github.com/ajv-validator/ajv/tree/master/lib/runtime) folder of the package. 

Completely isolated validation functions can be generated if desired (won't be for most use cases). Run the generated code through a bundler like ES Build to create completely isolated validation functions that can be imported/required without any dependency on Ajv. This is also not needed if your project is already using a bundler.

## Configuration and limitations

To support standalone code generation:

- Ajv option `code.source` must be set to `true`
- only `code` and `macro` user-defined keywords are supported (see [User defined keywords](./keywords.md)).
- when `code` keywords define variables in shared scope using `gen.scopeValue`, they must provide `code` property with the code snippet. See source code of pre-defined keywords for examples in [vocabularies folder](https://github.com/ajv-validator/ajv/blob/master/lib/vocabularies).
- if formats are used in standalone code, ajv option `code.formats` should contain the code snippet that will evaluate to an object with all used format definitions - it can be a call to `require("...")` with the correct path (relative to the location of saved module):

```javascript
import myFormats from "./my-formats"
import Ajv, {_} from "ajv"
const ajv = new Ajv({
  formats: myFormats,
  code: {
    source: true,
    formats: _`require("./my-formats")`,
  },
})

If you only use formats from [ajv-formats](https://github.com/ajv-validator/ajv-formats) this option will be set by this package automatically.

## Standalone package export

Ajv can generate a complete standalone validator package — a directory containing entry modules, shared definitions, runtime helpers, and format dependencies, together with a `package.json` manifest. The generated package is self-contained: all internal imports are relative, so the whole directory can be moved to another location and loaded without rebuilding.

### Generating a package

```javascript
const path = require("path")
const Ajv = require("ajv")
const standalonePackage = require("ajv/dist/standalone/package").default

const ajv = new Ajv({code: {source: true}})
ajv.addSchema({
  $id: "user.json",
  type: "object",
  properties: {
    name: {type: "string", minLength: 2},
  },
  required: ["name"],
})

standalonePackage(ajv, {
  user: "user.json",
}, {
  outDir: path.join(__dirname, "validator-package"),
})
```

The `standalonePackage` function accepts:

- `ajv` — an Ajv instance with `code.source: true`.
- `entries` — a map of export names to schema `$id`s (or compiled validate functions).
- `options.outDir` — the output directory.
- `options.esm` — set to `true` to generate ESM modules (default: `false`).
- `options.package` — additional fields to merge into the generated `package.json`.

### Package layout

The generated package has the following structure:

```
validator-package/
  package.json        # manifest listing entries, runtime helpers, and formats
  defs.js             # shared definitions (all validators and schemas)
  entries/
    user.js           # entry module that re-exports the validator
  formats/
    <format-name>.js  # format definition modules (for function/object formats)
  runtime/
    <helper-name>.js  # runtime helper modules (copied from Ajv)
```

Each entry module requires the shared `defs.js` and re-exports the validator:

```javascript
"use strict";
const defs = require("../defs");
module.exports = defs["user"];
module.exports.default = defs["user"];
```

### Package manifest

The generated `package.json` is a complete manifest of the package contents:

```json
{
  "name": "standalone-validator-package",
  "version": "1.0.0",
  "main": "defs.js",
  "files": ["defs.js", "entries/", "formats/", "runtime/"],
  "scripts": {
    "validate": "node validate.js"
  },
  "entries": {
    "user": "entries/user.js"
  },
  "runtime": {
    "ucs2length": "runtime/ucs2length.js"
  },
  "formats": {}
}
```

- `entries` — maps entry names to their module paths.
- `runtime` — maps runtime helper names to their module paths.
- `formats` — maps format names to their module paths.

### Validation guarantees

The package export performs all checks before writing any files (atomic writes):

- **Unsupported custom keywords** — keywords defined with `compile`/`validate` functions (which cannot be inlined into generated code) are reported as unsupported before the package is written. Only `code` and `macro` keywords are supported.
- **Unknown formats** — formats that are not registered with the Ajv instance prevent package generation.
- **Missing references** — `$ref`s that cannot be resolved prevent package generation; no half-package is written.
- **Filename collision prevention** — if two modules would have the same filename, a numeric suffix is added.

The generated validation functions produce the same results as the original Ajv instance, including default value filling (`useDefaults`).

### Using the generated package

```javascript
const user = require("./validator-package/entries/user")

if (user({name: "John"})) {
  console.log("valid")
} else {
  console.log("invalid:", user.errors)
}
```

The package can be moved to another directory or machine and loaded without rebuilding, as long as its external dependencies (listed in `package.json`) are available.
