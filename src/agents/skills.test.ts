import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultSkillDirs, SkillLibrary } from "./skills.ts"

let dir: string
const skill = (root: string, name: string, content: string) => {
  mkdirSync(join(dir, root, name), { recursive: true })
  writeFileSync(join(dir, root, name, "SKILL.md"), content)
}
const library = () => new SkillLibrary([join(dir, "first"), join(dir, "second"), join(dir, "missing")])
const named = (description: string, body = "Body") => `---\nname: Label\ndescription: ${description}\n---\n${body}\n`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravex-skills-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("lists skills by folder name, sorted, with their descriptions", () => {
  skill("first", "zeta", named("Last one"))
  skill("second", "alpha", named("First one"))
  mkdirSync(join(dir, "first", "not-a-skill"))
  expect(library().list().map((item) => [item.name, item.description])).toEqual([
    ["alpha", "First one"],
    ["zeta", "Last one"],
  ])
})

test("the earlier folder wins", () => {
  skill("first", "same", named("From first"))
  skill("second", "same", named("From second"))
  expect(library().list()[0]?.description).toBe("From first")
})

test("follows symlinks, which is how skills are often installed", () => {
  skill("second", "real", named("Linked"))
  mkdirSync(join(dir, "first"))
  symlinkSync(join(dir, "second", "real"), join(dir, "first", "link"))
  expect(library().list().map((item) => item.name)).toEqual(["link", "real"])
})

test("reads long descriptions, and survives no frontmatter or a broken one", () => {
  skill("first", "folded", "---\ndescription: >\n  Two\n  lines\n---\nBody")
  skill("first", "plain", "Just text")
  skill("first", "broken", "---\n: : [\n---\nBody")
  const byName = new Map(library().list().map((item) => [item.name, item.description]))
  expect(byName.get("folded")).toBe("Two lines")
  expect(byName.get("plain")).toBe("")
  expect(byName.get("broken")).toBe("")
})

test("resolves names into instructions without the frontmatter, and reports what's missing", () => {
  skill("first", "style", named("Style guide", "Use short names."))
  const { text, missing } = library().resolve(["style", "ghost"])
  expect(text).toContain("# Skill: style")
  expect(text).toContain("Use short names.")
  expect(text).toContain(join(dir, "first", "style"))
  expect(text).not.toContain("description:")
  expect(missing).toEqual(["ghost"])
})

test("points to a skill too long to fit, so a CLI's argument limit is never hit", () => {
  skill("first", "big", named("Huge", "x".repeat(70_000)))
  skill("first", "small", named("Tiny", "Short body"))
  const { text } = library().resolve(["big", "small"])
  expect(text.length).toBeLessThan(1_000)
  expect(text).toContain(`Read ${join(dir, "first", "big", "SKILL.md")}`)
  expect(text).toContain("Short body")
})

test("looks in the project first, then in each CLI's folders", () => {
  const dirs = defaultSkillDirs("/work", { XDG_CONFIG_HOME: "/cfg" })
  expect(dirs[0]).toBe(join("/work", ".ravex", "skills"))
  expect(dirs).toContain(join("/cfg", "opencode", "skills"))
  expect(dirs).toContain(join("/cfg", "ravex-agents", "skills"))
  expect(dirs.some((path) => path.endsWith(join(".claude", "skills")))).toBe(true)
  expect(dirs.some((path) => path.endsWith(join(".codex", "skills")))).toBe(true)
})
