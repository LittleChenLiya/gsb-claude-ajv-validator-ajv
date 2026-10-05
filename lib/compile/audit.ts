import type {SchemaCxt} from "."
import {_, str, Code, Name, CodeGen} from "./codegen"
import {getErrorPath, Type} from "./util"
import N from "./names"
import type {DataModEntry} from "../types"

export type DataModKind = DataModEntry["kind"]

// Generates code that records a data modification entry into the audit ledger.
// The ledger is read from the validation context (valCxt.dataMods) so that
// concurrent validations get isolated buffers. When no context ledger is
// provided, a fresh ledger is created on the validate function itself.
// Records never save the original value - only the kind, location and keyword.
export function recordDataMod(
  gen: CodeGen,
  it: SchemaCxt,
  kind: DataModKind,
  keyword: string,
  instancePath: Code = str`${N.instancePath}${it.errorPath}`
): void {
  gen.code(
    _`if (${N.dataMods}) ${
      N.dataMods
    }.push({kind: ${kind}, instancePath: ${instancePath}, keyword: ${keyword}, covered: ${
      kind !== "modifying"
    }})`
  )
}

// Builds the instance path for a modification at a static property name.
export function propInstancePath(it: SchemaCxt, prop: string | number): Code {
  return str`${N.instancePath}${it.errorPath}${getErrorPath(
    prop,
    typeof prop === "number" ? Type.Num : Type.Str
  )}`
}

// Builds the instance path for a modification at a runtime property name.
export function keyInstancePath(it: SchemaCxt, key: Name): Code {
  return str`${N.instancePath}${it.errorPath}${getErrorPath(key, Type.Str)}`
}
