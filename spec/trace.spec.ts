import type {BranchTraceEntry} from ".."
import _Ajv from "./ajv"
import chai from "./chai"
const should = chai.should()
const {assert} = chai

describe("if/then/else branch trace (option traceBranches)", () => {
  const schema = {
    type: "object",
    if: {properties: {kind: {const: "a"}}, required: ["kind"]},
    then: {required: ["x"]},
    else: {required: ["y"]},
  }

  describe("with traceBranches: true", () => {
    let ajv: InstanceType<typeof _Ajv>

    beforeEach(() => {
      ajv = new _Ajv({traceBranches: true})
    })

    it("should record the else branch when the condition fails, keeping errors unchanged", () => {
      const validate = ajv.compile(schema)
      const plain = new _Ajv().compile(schema)

      validate({kind: "b"}).should.equal(false)
      plain({kind: "b"}).should.equal(false)

      // same errors as validation without tracing
      assert.deepEqual(validate.errors, plain.errors)
      validate.errors?.[0].should.have.property("schemaPath", "#/else/required")

      // explicit trace: condition was executed, evaluated to false, else branch selected
      assert.deepEqual(validate.trace, [
        {keyword: "if", schemaPath: "#/if", instancePath: "", condition: false, branch: "else"},
      ])
    })

    it("should record the then branch when the condition passes", () => {
      const validate = ajv.compile(schema)
      validate({kind: "a"}).should.equal(false) // "x" is missing
      validate.errors?.[0].should.have.property("schemaPath", "#/then/required")
      assert.deepEqual(validate.trace, [
        {keyword: "if", schemaPath: "#/if", instancePath: "", condition: true, branch: "then"},
      ])
    })

    it("should record valid data evaluation without storing validated values", () => {
      const validate = ajv.compile(schema)
      validate({kind: "a", x: 1}).should.equal(true)
      should.equal(validate.errors, null)
      assert.deepEqual(validate.trace, [
        {keyword: "if", schemaPath: "#/if", instancePath: "", condition: true, branch: "then"},
      ])
      // trace entries must not contain validated data values
      for (const entry of validate.trace as BranchTraceEntry[]) {
        Object.keys(entry).should.have.members([
          "keyword",
          "schemaPath",
          "instancePath",
          "condition",
          "branch",
        ])
      }
      JSON.stringify(validate.trace).should.not.contain('"a"')
    })

    it("should record nested conditions separately with full schema paths", () => {
      const validate = ajv.compile({
        type: "object",
        if: {properties: {kind: {const: "a"}}, required: ["kind"]},
        then: {
          if: {properties: {level: {const: 1}}, required: ["level"]},
          then: {required: ["x"]},
          else: {required: ["y"]},
        },
        else: {required: ["z"]},
      })

      validate({kind: "a", level: 2}).should.equal(false) // inner else requires "y"
      assert.deepEqual(validate.trace, [
        {keyword: "if", schemaPath: "#/if", instancePath: "", condition: true, branch: "then"},
        {
          keyword: "if",
          schemaPath: "#/then/if",
          instancePath: "",
          condition: false,
          branch: "else",
        },
      ])

      validate({kind: "b"}).should.equal(false) // outer else requires "z", inner if not evaluated
      assert.deepEqual(validate.trace, [
        {keyword: "if", schemaPath: "#/if", instancePath: "", condition: false, branch: "else"},
      ])
    })

    it("should record conditions inside $ref-erenced schemas in the same trace", () => {
      const validate = ajv.compile({
        $defs: {
          cond: {
            type: "object",
            if: {properties: {kind: {const: "a"}}, required: ["kind"]},
            then: {required: ["x"]},
            else: {required: ["y"]},
          },
        },
        $ref: "#/$defs/cond",
      })

      validate({kind: "b"}).should.equal(false)
      assert.equal(validate.trace?.length, 1)
      assert.equal(validate.trace?.[0].condition, false)
      assert.equal(validate.trace?.[0].branch, "else")
      assert.match(validate.trace?.[0].schemaPath ?? "", /^#\/(\$defs\/cond\/)?if$/)
    })

    it("should record instancePath of nested instance locations", () => {
      const validate = ajv.compile({
        type: "object",
        properties: {
          item: {
            type: "object",
            if: {properties: {kind: {const: "a"}}, required: ["kind"]},
            then: {required: ["x"]},
            else: {required: ["y"]},
          },
        },
      })
      validate({item: {kind: "b"}}).should.equal(false)
      assert.deepEqual(validate.trace, [
        {
          keyword: "if",
          schemaPath: "#/properties/item/if",
          instancePath: "/item",
          condition: false,
          branch: "else",
        },
      ])
    })

    it("should use a caller-provided trace collector passed via data context", () => {
      const validate = ajv.compile(schema)
      const trace: BranchTraceEntry[] = []
      validate({kind: "b"}, {trace} as any).should.equal(false)
      assert.deepEqual(trace, [
        {keyword: "if", schemaPath: "#/if", instancePath: "", condition: false, branch: "else"},
      ])
      // the same buffer is exposed on the validation function
      should.equal(validate.trace, trace)
    })

    it("should execute async custom keywords only once and isolate concurrent trace buffers", async () => {
      const asyncAjv = new _Ajv({traceBranches: true})
      let calls = 0
      let arrived = 0
      let release!: () => void
      const gate = new Promise<void>((res) => (release = res))
      asyncAjv.addKeyword({
        keyword: "barrier",
        async: true,
        validate: async () => {
          calls++
          // barrier: both concurrent validations must be inside the keyword
          // before either continues, proving the buffers stay isolated
          if (++arrived === 2) release()
          await gate
          return true
        },
      })
      const validate = asyncAjv.compile({
        $async: true,
        type: "object",
        if: {properties: {kind: {const: "a"}}, required: ["kind"]},
        then: {barrier: true},
        else: {barrier: true},
      })

      const trace1: BranchTraceEntry[] = []
      const trace2: BranchTraceEntry[] = []
      const [data1, data2] = await Promise.all([
        validate({kind: "a"}, {trace: trace1} as any),
        validate({kind: "b"}, {trace: trace2} as any),
      ])
      assert.deepEqual(data1, {kind: "a"})
      assert.deepEqual(data2, {kind: "b"})

      // async custom keyword executed exactly once per validation (not re-run for tracing)
      calls.should.equal(2)

      // concurrent validations did not share the trace buffer
      assert.notEqual(trace1, trace2)
      assert.deepEqual(trace1, [
        {keyword: "if", schemaPath: "#/if", instancePath: "", condition: true, branch: "then"},
      ])
      assert.deepEqual(trace2, [
        {keyword: "if", schemaPath: "#/if", instancePath: "", condition: false, branch: "else"},
      ])
    })

    it("should record trace for async validation failures", async () => {
      const asyncAjv = new _Ajv({traceBranches: true})
      const validate: any = asyncAjv.compile({...schema, $async: true} as any)
      const trace: BranchTraceEntry[] = []
      let err: unknown
      try {
        await validate({kind: "b"}, {trace} as any)
      } catch (e) {
        err = e
      }
      should.exist(err)
      assert.deepEqual(trace, [
        {keyword: "if", schemaPath: "#/if", instancePath: "", condition: false, branch: "else"},
      ])
    })
  })

  describe("with default options (traceBranches not enabled)", () => {
    it("should not generate any trace code", () => {
      const validate = new _Ajv().compile(schema)
      validate({kind: "b"}).should.equal(false)
      should.equal(validate.trace, undefined)
      validate.toString().should.not.contain("trace")
    })
  })
})
