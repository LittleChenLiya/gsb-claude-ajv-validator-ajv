import type Ajv from "../lib/ajv"
import type {ModificationRecord} from "../lib/types"
import _Ajv from "../lib/ajv"
import chai from "./chai"
chai.should()

const AjvClass = _Ajv as unknown as typeof Ajv

describe("modificationAudit option", () => {
  it("should record coerce and removeAdditional locations in the ledger", () => {
    const ajv = new AjvClass({
      coerceTypes: true,
      removeAdditional: true,
      modificationAudit: true,
    })
    const validate = ajv.compile({
      type: "object",
      properties: {n: {type: "integer"}},
      additionalProperties: false,
    })
    const data: any = {n: "12", extra: 1}
    validate(data).should.equal(true)
    data.should.deep.equal({n: 12})
    validate.modifications!.should.deep.equal([
      {keyword: "removeAdditional", instancePath: "/extra", propertyName: "extra"},
      {keyword: "coerce", instancePath: "/n"},
    ])
  })

  it("should not store original values in the records", () => {
    const ajv = new AjvClass({
      coerceTypes: true,
      useDefaults: true,
      removeAdditional: true,
      modificationAudit: true,
    })
    const validate = ajv.compile({
      type: "object",
      properties: {n: {type: "integer"}, s: {type: "string", default: "x"}},
      additionalProperties: false,
    })
    const data: any = {n: "12", extra: "secret"}
    validate(data).should.equal(true)
    for (const rec of validate.modifications!) {
      Object.keys(rec)
        .sort()
        .should.deep.equal(
          rec.propertyName === undefined
            ? ["instancePath", "keyword"]
            : ["instancePath", "keyword", "propertyName"]
        )
      JSON.stringify(rec).should.not.contain("secret")
      JSON.stringify(rec).should.not.contain('"12"')
    }
  })

  it("should keep defaults inserted before a validation failure visible", () => {
    const ajv = new AjvClass({useDefaults: true, modificationAudit: true})
    const validate = ajv.compile({
      type: "object",
      properties: {a: {type: "number", default: 1}, b: {type: "string"}},
      required: ["b"],
    })
    const data: any = {}
    validate(data).should.equal(false)
    data.a.should.equal(1) // the real modification is preserved
    validate.modifications!.should.deep.equal([
      {keyword: "useDefaults", instancePath: "/a", propertyName: "a"},
    ])
  })

  it("should record removal of properties failing additionalProperties schema", () => {
    const ajv = new AjvClass({
      coerceTypes: true,
      removeAdditional: "failing",
      modificationAudit: true,
    })
    const validate = ajv.compile({
      type: "object",
      properties: {n: {type: "integer"}},
      additionalProperties: {type: "boolean"},
    })
    const data: any = {n: "12", extra: "not-boolean"}
    validate(data).should.equal(true) // failing additional property is removed, not an error
    data.should.deep.equal({n: 12})
    validate.modifications!.should.deep.equal([
      {keyword: "removeAdditional", instancePath: "/extra", propertyName: "extra"},
      {keyword: "coerce", instancePath: "/n"},
    ])
  })

  it("should not increase user callback invocation counts", () => {
    let calls = 0
    const schema = {
      type: "object",
      properties: {n: {type: "integer", countMe: true}},
    }
    const makeAjv = (modificationAudit: boolean) => {
      const ajv = new AjvClass({coerceTypes: true, modificationAudit, strict: false})
      ajv.addKeyword({
        keyword: "countMe",
        type: "integer",
        schemaType: "boolean",
        validate: () => {
          calls++
          return true
        },
      })
      return ajv
    }
    let validate = makeAjv(false).compile(schema)
    validate({n: "1"})
    validate({n: "2"})
    const withoutAudit = calls
    calls = 0
    validate = makeAjv(true).compile(schema)
    validate({n: "1"})
    validate({n: "2"})
    calls.should.equal(withoutAudit)
    calls.should.equal(2)
  })

  it("should isolate audit buffers of concurrent validations", async () => {
    const ajv = new AjvClass({coerceTypes: true, modificationAudit: true, strict: false})
    ajv.addKeyword({
      keyword: "tick",
      async: true,
      schemaType: "boolean",
      validate: async () => {
        await new Promise((r) => setImmediate(r))
        return true
      },
    })
    const validate = ajv.compile({
      $async: true,
      type: "object",
      properties: {n: {type: "integer", tick: true}},
    })
    const buf1: ModificationRecord[] = []
    const buf2: ModificationRecord[] = []
    const d1: any = {n: "1"}
    const d2: any = {n: "2"}
    const [r1, r2]: any[] = await Promise.all([
      validate(d1, {modifications: buf1} as any),
      validate(d2, {modifications: buf2} as any),
    ])
    r1.should.equal(d1)
    r2.should.equal(d2)
    d1.n.should.equal(1)
    d2.n.should.equal(2)
    buf1.should.deep.equal([{keyword: "coerce", instancePath: "/n"}])
    buf2.should.deep.equal([{keyword: "coerce", instancePath: "/n"}])
    chai.expect(buf1).to.not.equal(buf2)
  })

  it("should isolate buffers of sequential calls without a provided buffer", () => {
    const ajv = new AjvClass({coerceTypes: true, modificationAudit: true})
    const validate = ajv.compile({type: "object", properties: {n: {type: "integer"}}})
    validate({n: "1"})
    const mods1 = validate.modifications
    validate({n: "2"})
    const mods2 = validate.modifications
    mods1!.should.deep.equal([{keyword: "coerce", instancePath: "/n"}])
    mods2!.should.deep.equal([{keyword: "coerce", instancePath: "/n"}])
    chai.expect(mods1).to.not.equal(mods2)
  })

  it("should mark custom modifying keywords as not covered", () => {
    const ajv = new AjvClass({useDefaults: true, modificationAudit: true, strict: false})
    ajv.addKeyword({
      keyword: "shout",
      type: "string",
      schemaType: "boolean",
      modifying: true,
      validate: (schema, data, _parentSchema, dataCxt) => {
        if (schema && dataCxt) {
          dataCxt.parentData[dataCxt.parentDataProperty] = data + "!"
        }
        return true
      },
    })
    const validate = ajv.compile({
      type: "object",
      properties: {
        s: {type: "string", shout: true},
        a: {type: "number", default: 1},
      },
    })
    const data: any = {s: "hi"}
    validate(data).should.equal(true)
    data.should.deep.equal({s: "hi!", a: 1})
    // the custom keyword modification is not tracked, only the default is
    validate.modifications!.should.deep.equal([
      {keyword: "useDefaults", instancePath: "/a", propertyName: "a"},
    ])
    validate.modificationsUncovered!.should.equal(true)
  })

  it("should not change generated code and semantics when the option is not used", () => {
    const schema = {
      type: "object",
      properties: {n: {type: "integer"}, a: {type: "number", default: 1}},
      additionalProperties: false,
    }
    const ajv = new AjvClass({coerceTypes: true, useDefaults: true, removeAdditional: true})
    const validate = ajv.compile(schema)
    const data: any = {n: "12", extra: 1}
    validate(data).should.equal(true)
    data.should.deep.equal({n: 12, a: 1}) // side effects unchanged
    chai.expect(validate.modifications).to.equal(undefined)
    chai.expect(validate.modificationsUncovered).to.equal(undefined)
    validate.toString().should.not.contain("modifications")
  })

  it("should record modifications in referenced schemas into the root call buffer", () => {
    const ajv = new AjvClass({coerceTypes: true, modificationAudit: true})
    const validate = ajv.compile({
      type: "object",
      properties: {
        n: {type: "integer"},
        sub: {$ref: "#/definitions/sub"},
      },
      definitions: {
        sub: {type: "object", properties: {m: {type: "integer"}}},
      },
    })
    const data: any = {n: "1", sub: {m: "2"}}
    validate(data).should.equal(true)
    data.should.deep.equal({n: 1, sub: {m: 2}})
    validate.modifications!.should.deep.equal([
      {keyword: "coerce", instancePath: "/n"},
      {keyword: "coerce", instancePath: "/sub/m"},
    ])
  })
})
