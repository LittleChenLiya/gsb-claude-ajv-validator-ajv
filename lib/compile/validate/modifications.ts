import type {SchemaObjCxt} from ".."
import type {ModificationRecord} from "../../types"
import {_, str, strConcat, Name} from "../codegen"
import {getErrorPath, Type} from "../util"
import N from "../names"

export type ModificationKind = ModificationRecord["keyword"]

// Generates code that records one data modification at the moment it is actually
// applied by the generated validation code (option modificationAudit).
// The record is pushed to the per-call audit buffer (`modifications`), so
// concurrent validation calls never share a buffer. The record contains the
// source keyword and the data location only - original values are never stored.
// It does not re-validate data nor invoke any (custom) keyword - it only logs
// the modification that the already generated code is performing anyway.
export function recordModification(
  it: SchemaObjCxt,
  keyword: ModificationKind,
  dataProp?: Name | string | number,
  dataPropType?: Type
): void {
  const {gen, opts} = it
  if (!opts.modificationAudit) return
  const dataPath =
    dataProp === undefined
      ? it.errorPath
      : str`${it.errorPath}${getErrorPath(dataProp, dataPropType, opts.jsPropertySyntax)}`
  const instancePath = strConcat(N.instancePath, dataPath)
  const record =
    dataProp === undefined
      ? _`{keyword: ${keyword}, instancePath: ${instancePath}}`
      : _`{keyword: ${keyword}, instancePath: ${instancePath}, propertyName: ${dataProp}}`
  gen.code(_`${N.modifications}.push(${record})`)
}
