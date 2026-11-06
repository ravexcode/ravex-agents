import { describe, expect, test } from "bun:test"
import { slugify, validateAgent } from "./identity.ts"

describe("slugify", () => {
  test("makes readable IDs, including from accented names", () => {
    expect(slugify("Diseño UX")).toBe("diseno-ux")
    expect(slugify("  Cyber--Security! ")).toBe("cyber-security")
    expect(slugify("!!!")).toBe("")
  })
})

describe("validateAgent", () => {
  const agent = (id: string) => ({ id, name: id })

  test("requires a usable, unique, unreserved name", () => {
    expect(validateAgent(agent(""), [])).toContain("obligatorio")
    expect(validateAgent({ id: "", name: "!!!" }, [])).toContain("una letra")
    expect(validateAgent(agent("room"), [])).toContain("reservado")
    expect(validateAgent(agent("a"), [agent("a")])).toContain("Ya existe")
  })

  test("lets an agent keep its own ID when edited", () => {
    expect(validateAgent(agent("a"), [agent("a")], "a")).toBeUndefined()
  })
})
