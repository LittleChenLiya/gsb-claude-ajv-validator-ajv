import _Ajv from "./ajv"
import chai from "./chai"
const expect = chai.expect

describe("if/then/else trace", () => {
  it("should record the condition result and selected branch", () => {
    const ajv = new _Ajv({traceIf: true, allErrors: true})
    const validate = ajv.compile({
      type: "object",
      if: {properties: {kind: {const: "a"}}, required: ["kind"]},
      then: {required: ["x"]},
      else: {required: ["y"]},
    })

    const traceB: any[] = []
    const validB = validate({kind: "b"}, {trace: traceB} as any)
    expect(validB).to.equal(false)
    expect(traceB).to.deep.equal([
      {schemaPath: "#/if", instancePath: "", result: false, branch: "else"},
    ])
    expect((validate.errors || []).map((e) => e.message)).to.include("must have required property 'y'")

    const traceA: any[] = []
    const validA = validate({kind: "a"}, {trace: traceA} as any)
    expect(validA).to.equal(false)
    expect(traceA).to.deep.equal([
      {schemaPath: "#/if", instancePath: "", result: true, branch: "then"},
    ])
    expect((validate.errors || []).map((e) => e.message)).to.include("must have required property 'x'")
  })

  it("should record nested conditions with complete schema paths", () => {
    const ajv = new _Ajv({traceIf: true, allErrors: true})
    const validate = ajv.compile({
      type: "object",
      if: {properties: {kind: {const: "a"}}, required: ["kind"]},
      then: {
        type: "object",
        properties: {
          x: {
            if: {properties: {flag: {const: true}}, required: ["flag"]},
            then: {required: ["y"]},
            else: {required: ["z"]},
          },
        },
      },
      else: {required: ["w"]},
    })

    const trace: any[] = []
    validate({kind: "a", x: {flag: false}}, {trace} as any)
    expect(trace).to.deep.equal([
      {schemaPath: "#/if", instancePath: "", result: true, branch: "then"},
      {schemaPath: "#/then/properties/x/if", instancePath: "/x", result: false, branch: "else"},
    ])
  })

  it("should trace $ref conditions", () => {
    const ajv = new _Ajv({traceIf: true, allErrors: true})
    ajv.addSchema({
      $id: "https://example.com/defs",
      $defs: {cond: {properties: {kind: {const: "a"}}, required: ["kind"]}},
    } as any)
    const validate = ajv.compile({
      $id: "https://example.com/main",
      type: "object",
      if: {$ref: "https://example.com/defs#/$defs/cond"},
      then: {required: ["x"]},
      else: {required: ["y"]},
    } as any)

    const trace: any[] = []
    validate({kind: "b"}, {trace} as any)
    expect(trace).to.deep.equal([
      {schemaPath: "#/if", instancePath: "", result: false, branch: "else"},
    ])
  })

  it("should keep valid and errors identical to validation without tracing", () => {
    const schema = {
      type: "object",
      if: {properties: {kind: {const: "a"}}, required: ["kind"]},
      then: {required: ["x"]},
      else: {required: ["y"]},
    }
    const vOff = new _Ajv({allErrors: true}).compile(schema)
    const vOn = new _Ajv({traceIf: true, allErrors: true}).compile(schema)
    const data = {kind: "b"}

    const offValid = vOff(data)
    const onValid = vOn(data, {trace: []} as any)
    expect(onValid).to.equal(offValid)
    const offErrors = (vOff.errors || []).map((e) => e.message).sort()
    const onErrors = (vOn.errors || []).map((e) => e.message).sort()
    expect(onErrors).to.deep.equal(offErrors)
  })

  it("should isolate trace buffers between concurrent async validations", async () => {
    let barrierResolve: () => void
    const barrier = new Promise<void>((r) => { barrierResolve = r })
    let callCount = 0

    const ajv = new _Ajv({traceIf: true, allErrors: true})
    ajv.addKeyword({
      keyword: "waitBarrier",
      async: true,
      type: "object",
      validate: async () => { callCount++; await barrier; return true },
    } as any)

    const validate = ajv.compile({
      $async: true,
      type: "object",
      waitBarrier: true,
      if: {properties: {kind: {const: "a"}}, required: ["kind"]},
      then: {required: ["x"]},
      else: {required: ["y"]},
    } as any)

    const trace1: any[] = []
    const trace2: any[] = []
    const p1 = validate({kind: "b"}, {trace: trace1} as any)
    const p2 = validate({kind: "a"}, {trace: trace2} as any)
    barrierResolve!()
    await Promise.all([p1, p2]).catch(() => {})

    expect(callCount).to.equal(2)
    expect(trace1).to.deep.equal([
      {schemaPath: "#/if", instancePath: "", result: false, branch: "else"},
    ])
    expect(trace2).to.deep.equal([
      {schemaPath: "#/if", instancePath: "", result: true, branch: "then"},
    ])
  })

  it("should not add trace code when the option is disabled", () => {
    const schema = {
      type: "object",
      if: {properties: {kind: {const: "a"}}},
      then: {required: ["x"]},
      else: {required: ["y"]},
    }
    const vOff = new _Ajv({code: {source: true}}).compile(schema)
    expect((vOff as any).source.validateCode).to.not.include("trace")

    const vOn = new _Ajv({traceIf: true, code: {source: true}}).compile(schema)
    expect((vOn as any).source.validateCode).to.include("trace")
  })
})
