import { describe, expect, test } from "bun:test"
import { buildInstructions, formatResults, MAX_RESULT_LENGTH, MAX_TASKS_PER_ROUND, parseDelegation } from "./delegation.ts"
import type { Agent } from "./types.ts"

const block = (body: string) => "```ravex-delegate\n" + body + "\n```"
const tasks = (...items: { agent: string; task: string }[]) => block(JSON.stringify({ tasks: items }))

const agent = (id: string, overrides: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  description: "",
  provider: "claude",
  instructions: "",
  mode: "read-only",
  subagents: [],
  origin: "global",
  ...overrides,
})

describe("parseDelegation", () => {
  test("reads the tasks and separates them from the message", () => {
    expect(parseDelegation(`Checking this.\n\n${tasks({ agent: "security", task: "Audit" })}\n`)).toEqual({
      text: "Checking this.",
      tasks: [{ agent: "security", task: "Audit" }],
    })
  })

  test("ignores messages without a block", () => {
    expect(parseDelegation("Just an answer")).toBeNull()
    expect(parseDelegation("```json\n{}\n```")).toBeNull()
  })

  test("ignores a block that doesn't end the message, such as a quoted example", () => {
    expect(parseDelegation(`The format is:\n${tasks({ agent: "a", task: "b" })}\nThat's how it works.`)).toBeNull()
  })

  test("handles code fences inside a task", () => {
    const task = "Fix:\n```ts\nlet a\n```\nthanks"
    expect(parseDelegation(tasks({ agent: "a", task }))?.tasks).toEqual([{ agent: "a", task }])
  })

  test("reports malformed blocks instead of ignoring them", () => {
    expect(parseDelegation(block("{nope"))?.error).toContain("valid JSON")
    expect(parseDelegation(block("{}"))?.error).toContain("tasks")
    expect(parseDelegation(block('{"tasks":[]}'))?.error).toContain("tasks")
    expect(parseDelegation(block('{"tasks":[{"agent":"a"}]}'))?.error).toContain("task")
    expect(parseDelegation(block('{"tasks":[{"agent":"a","task":"  "}]}'))?.error).toContain("task")
    expect(parseDelegation(block("null"))?.error).toContain("tasks")
  })

  test("rejects too many tasks rather than silently dropping some", () => {
    const many = Array.from({ length: MAX_TASKS_PER_ROUND + 1 }, () => ({ agent: "a", task: "b" }))
    const parsed = parseDelegation(tasks(...many))
    expect(parsed?.error).toContain("at most")
    expect(parsed?.tasks).toEqual([])
  })
})

describe("buildInstructions", () => {
  test("leaves agents without subagents untouched", () => {
    expect(buildInstructions(agent("a", { instructions: "Be brief" }), [])).toBe("Be brief")
    expect(buildInstructions(agent("a"), [])).toBe("")
  })

  test("describes each subagent and the format", () => {
    const text = buildInstructions(agent("a", { instructions: "Be brief" }), [
      agent("security", { description: "Audits code" }),
      agent("design", { name: "Design" }),
    ])
    expect(text).toStartWith("Be brief")
    expect(text).toContain("- security: Audits code")
    expect(text).toContain("- design: Design")
    expect(text).toContain("```ravex-delegate")
  })
})

describe("formatResults", () => {
  test("includes each result's agent, status and output", () => {
    const text = formatResults([
      { agent: "a", status: "done", output: "found" },
      { agent: "b", status: "failed", output: "" },
    ])
    expect(text).toContain("## a (done)\nfound")
    expect(text).toContain("## b (failed)\n(no output)")
  })

  test("truncates long results and says so", () => {
    const text = formatResults([{ agent: "a", status: "done", output: "x".repeat(MAX_RESULT_LENGTH + 500) }])
    expect(text).toContain("[Truncated")
    expect(text.length).toBeLessThan(MAX_RESULT_LENGTH + 300)
  })
})
