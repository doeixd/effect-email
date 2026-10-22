import { assert, describe, it } from "@effect/vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = process.cwd()
const pkg = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8")
) as {
  readonly exports: Readonly<Record<string, string>>
}

describe("Package surface", () => {
  it("points every export at an existing source file", () => {
    for (const [name, target] of Object.entries(pkg.exports)) {
      assert.isTrue(
        existsSync(resolve(root, target)),
        `export ${name} points at missing ${target}`
      )
    }
  })

  it("keeps the root entrypoint free of provider and Node-only imports", () => {
    const source = readFileSync(resolve(root, "src/index.ts"), "utf8")

    assert.notInclude(source, "./providers/")
    assert.notInclude(source, "./smtp/Node")
    assert.notInclude(source, "./server/Node")
    assert.notInclude(source, "@effect/platform-node")
    assert.notInclude(source, "node:")
  })

  it("exports only stable core namespaces from the root", async () => {
    const index = await import("../src/index")
    const expected = [
      "Message",
      "Email",
      "EmailTransport",
      "EmailError",
      "DeliveryStore",
      "Submissions",
      "Submission",
      "SubmissionAdmission",
      "Template",
      "Spool",
      "Suppression",
      "Gateway",
      "Catcher",
      "Ids"
    ]

    for (const name of expected) {
      assert.property(index, name)
    }
    assert.notProperty(index, "providers")
    assert.notProperty(index, "Smtp")
  })
})
