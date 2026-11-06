import { describe, expect, test } from "bun:test"
import { buildTree, removeCycles, rootIds, slugify, validateAgent } from "./graph.ts"

const agent = (id: string, ...subagents: string[]) => ({ id, name: id, subagents })

describe("slugify", () => {
  test("makes readable IDs, including from accented names", () => {
    expect(slugify("Diseño UX")).toBe("diseno-ux")
    expect(slugify("  Cyber--Security! ")).toBe("cyber-security")
    expect(slugify("!!!")).toBe("")
  })
})

describe("validateAgent", () => {
  test("requires a usable, unique, unreserved name", () => {
    expect(validateAgent(agent(""), [])).toContain("required")
    expect(validateAgent({ id: "", name: "!!!", subagents: [] }, [])).toContain("letter or number")
    expect(validateAgent(agent("all"), [])).toContain("reserved")
    expect(validateAgent(agent("a"), [agent("a")])).toContain("already exists")
  })

  test("lets an agent keep its own ID when edited", () => {
    expect(validateAgent(agent("a"), [agent("a")], "a")).toBeUndefined()
  })

  test("rejects assigning an agent to itself", () => {
    expect(validateAgent(agent("a", "a"), [])).toContain("cycle")
  })

  test("rejects cycles through other agents", () => {
    expect(validateAgent(agent("a", "b"), [agent("a"), agent("b", "c"), agent("c", "a")], "a")).toContain("cycle")
  })

  test("allows a chain of 3 steps and rejects 4", () => {
    const chain = [agent("b", "c"), agent("c", "d"), agent("d")]
    expect(validateAgent(agent("a", "b"), chain)).toBeUndefined()
    expect(validateAgent(agent("a", "b"), [...chain.slice(0, 2), agent("d", "e"), agent("e")])).toContain("at most 3")
  })

  test("catches a chain made too long from above the edited agent", () => {
    const agents = [agent("a", "b"), agent("b", "c"), agent("c"), agent("d", "e"), agent("e")]
    expect(validateAgent(agent("c", "d"), agents, "c")).toContain("at most 3")
  })

  test("ignores assignments to agents that no longer exist", () => {
    expect(validateAgent(agent("a", "deleted"), [])).toBeUndefined()
  })
})

describe("removeCycles", () => {
  test("breaks hand-written cycles and keeps other assignments", () => {
    const result = removeCycles([agent("a", "b", "c"), agent("b", "a"), agent("c")])
    expect(result.find((a) => a.id === "a")?.subagents).toEqual(["b", "c"])
    expect(result.find((a) => a.id === "b")?.subagents).toEqual([])
  })

  test("removes self-assignment", () => {
    expect(removeCycles([agent("a", "a")])[0]?.subagents).toEqual([])
  })

  test("leaves diamonds alone", () => {
    const agents = [agent("a", "b", "c"), agent("b", "d"), agent("c", "d"), agent("d")]
    expect(removeCycles(agents)).toEqual(agents)
  })
})

describe("tree", () => {
  test("nests subagents under parents, and lists unassigned agents as roots", () => {
    const agents = [agent("lead", "security", "design"), agent("security"), agent("design"), agent("solo")]
    expect(rootIds(agents)).toEqual(["lead", "solo"])
    expect(buildTree(agents).map((row) => [row.agentId, row.depth, row.isLastSibling])).toEqual([
      ["lead", 0, false],
      ["security", 1, false],
      ["design", 1, true],
      ["solo", 0, true],
    ])
  })

  test("shows a shared subagent under each parent with unique keys", () => {
    const rows = buildTree([agent("a", "x"), agent("b", "x"), agent("x")])
    expect(rows.map((row) => row.agentId)).toEqual(["a", "x", "b", "x"])
    expect(new Set(rows.map((row) => row.key)).size).toBe(4)
  })

  test("doesn't treat a deleted subagent as a child", () => {
    expect(buildTree([agent("a", "deleted")]).map((row) => row.agentId)).toEqual(["a"])
  })
})
