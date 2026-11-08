import { expect, test } from "bun:test"
import { commandMatches, parseSlash } from "./commands.ts"

test("reads a command and its argument", () => {
  expect(parseSlash("/agent  Codex ")).toMatchObject({ command: { name: "agent" }, args: "Codex" })
  expect(parseSlash("/NEW")).toMatchObject({ command: { name: "new" }, args: "" })
  expect(parseSlash("/clear")).toMatchObject({ command: { name: "new" } })
  expect(parseSlash("/exit")).toMatchObject({ command: { name: "quit" } })
})

test("tells an unknown command apart from a message", () => {
  expect(parseSlash("/nope")).toEqual({ unknown: "nope" })
  expect(parseSlash("/etc/hosts looks wrong")).toBeUndefined()
  expect(parseSlash(" /new")).toBeUndefined()
  expect(parseSlash("fix /new")).toBeUndefined()
  expect(parseSlash("/")).toBeUndefined()
})

test("offers commands only while a name is being typed", () => {
  expect(commandMatches("/").length).toBeGreaterThan(5)
  expect(commandMatches("/re").map((command) => command.name)).toEqual(["resume"])
  expect(commandMatches("/cl").map((command) => command.name)).toEqual(["new"])
  expect(commandMatches("/agent codex")).toEqual([])
  expect(commandMatches("/etc/hosts")).toEqual([])
  expect(commandMatches("hello")).toEqual([])
})

const skills = [
  { name: "review", description: "Review code" },
  { name: "figma:figma-use", description: "Use Figma" },
  { name: "new", description: "Shares a name with a command" },
]

test("reads a skill and its request, and commands win over skills", () => {
  expect(parseSlash("/review the login", skills)).toEqual({ skill: "review", args: "the login" })
  expect(parseSlash("/figma:figma-use", skills)).toEqual({ skill: "figma:figma-use", args: "" })
  expect(parseSlash("/new", skills)).toMatchObject({ command: { name: "new" } })
  expect(parseSlash("/review")).toEqual({ unknown: "review" })
})

test("offers skills after the commands", () => {
  expect(commandMatches("/re", skills).map((offer) => offer.name)).toEqual(["resume", "review"])
  expect(commandMatches("/fig", skills)[0]).toMatchObject({ name: "figma:figma-use", skill: true })
  expect(commandMatches("/ne", skills).map((offer) => offer.name)).toEqual(["new"])
})
