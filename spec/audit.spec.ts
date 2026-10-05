import _Ajv from "./ajv"
import chai from "./chai"
chai.should()
const {expect} = chai
import type {DataModEntry} from "../dist/types"

describe("auditDataMods option", () => {
  it("should record coerce and removeAdditional with accurate ledger entries", () => {
    const ajv = new _Ajv({coerceTypes: true, removeAdditional: true, auditDataMods: true})
    const schema = {
      type: "object",
      properties: {
        n: {type: "integer"},
        s: {type: "string"},
      },
      additionalProperties: false,
    }
    const validate = ajv.compile(schema)
    const data = {n: "12", s: "hello", extra: "x"}
    const dataMods: DataModEntry[] = []
    validate(data, {dataMods})

    data.should.eql({n: 12, s: "hello"})
    dataMods.should.have.length(2)
    const coerce = dataMods.find((e) => e.kind === "coerce")!
    coerce.should.eql({kind: "coerce", instancePath: "/n", keyword: "type", covered: true})
    const remove = dataMods.find((e) => e.kind === "removeAdditional")!
    remove.should.eql({
      kind: "removeAdditional",
      instancePath: "/extra",
      keyword: "additionalProperties",
      covered: true,
    })
  })

  it("should keep default inserted after validation failure", () => {
    const ajv = new _Ajv({useDefaults: true, auditDataMods: true})
    const schema = {
      type: "object",
      properties: {
        n: {type: "integer"},
        d: {type: "string", default: "def"},
      },
      required: ["n"],
    }
    const validate = ajv.compile(schema)
    const data: any = {n: "notanumber"}
    const dataMods: DataModEntry[] = []
    const valid = validate(data, {dataMods})

    valid.should.equal(false)
    data.d.should.equal("def")
    dataMods.should.have.length(1)
    dataMods[0].should.eql({
      kind: "useDefaults",
      instancePath: "/d",
      keyword: "default",
      covered: true,
    })
  })

  it("should record each mutation exactly once (no duplicate entries)", () => {
    const ajv = new _Ajv({
      coerceTypes: true,
      useDefaults: true,
      removeAdditional: true,
      auditDataMods: true,
    })
    const schema = {
      type: "object",
      properties: {
        n: {type: "integer"},
        d: {type: "string", default: "x"},
      },
      additionalProperties: false,
    }
    const validate = ajv.compile(schema)
    const data = {n: "5", extra: "e"}
    const dataMods: DataModEntry[] = []
    validate(data, {dataMods})

    dataMods.should.have.length(3)
    const kinds = dataMods.map((e) => e.kind).sort()
    kinds.should.eql(["coerce", "removeAdditional", "useDefaults"])
  })

  it("should isolate buffers for concurrent validations", () => {
    const ajv = new _Ajv({coerceTypes: true, auditDataMods: true})
    const schema = {type: "object", properties: {n: {type: "integer"}}}
    const validate = ajv.compile(schema)

    const dataA = {n: "100"}
    const dataB = {n: "200"}
    const modsA: DataModEntry[] = []
    const modsB: DataModEntry[] = []

    validate(dataA, {dataMods: modsA})
    validate(dataB, {dataMods: modsB})

    dataA.should.eql({n: 100})
    dataB.should.eql({n: 200})
    modsA.should.have.length(1)
    modsB.should.have.length(1)
    modsA[0].instancePath.should.equal("/n")
    modsB[0].instancePath.should.equal("/n")
    modsA.should.not.equal(modsB)
  })

  it("should mark modifying custom keywords as uncovered", () => {
    const ajv = new _Ajv({auditDataMods: true})
    ajv.addKeyword({
      keyword: "modify",
      modifying: true,
      validate: function (_schema, data) {
        data.modified = true
        return true
      },
    })
    const schema = {type: "object", modify: true}
    const validate = ajv.compile(schema)
    const data: any = {foo: "bar"}
    const dataMods: DataModEntry[] = []
    validate(data, {dataMods})

    data.should.eql({foo: "bar", modified: true})
    dataMods.should.have.length(1)
    dataMods[0].should.eql({
      kind: "modifying",
      instancePath: "",
      keyword: "modify",
      covered: false,
    })
  })

  it("should expose a function-level ledger when no context buffer is provided", () => {
    const ajv = new _Ajv({coerceTypes: true, auditDataMods: true})
    const schema = {type: "object", properties: {n: {type: "integer"}}}
    const validate = ajv.compile(schema)
    const data = {n: "42"}
    validate(data)

    data.should.eql({n: 42})
    ;(validate as any).dataMods.should.have.length(1)
    ;(validate as any).dataMods[0].should.eql({
      kind: "coerce",
      instancePath: "/n",
      keyword: "type",
      covered: true,
    })
  })

  it("should not record anything when auditDataMods is disabled", () => {
    const ajv = new _Ajv({coerceTypes: true})
    const schema = {type: "object", properties: {n: {type: "integer"}}}
    const validate = ajv.compile(schema)
    const data = {n: "42"}
    validate(data)

    data.should.eql({n: 42})
    expect((validate as any).dataMods).to.equal(undefined)
  })
})
