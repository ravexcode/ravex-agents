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
const library = () =>
  new SkillLibrary([
    { path: join(dir, "first"), source: "agents" },
    { path: join(dir, "second"), source: "agents" },
    { path: join(dir, "missing"), source: "agents" },
  ])
const named = (description: string, body = "Body") => `---\ndescription: ${description}\n---\n${body}\n`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravex-skills-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("lists skills without a title by folder name, sorted, with their descriptions", () => {
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
  const dirs = defaultSkillDirs("/work", { XDG_CONFIG_HOME: "/cfg" }).map((entry) => entry.path)
  expect(dirs[0]).toBe(join("/work", ".ravex", "skills"))
  expect(dirs).toContain(join("/cfg", "opencode", "skills"))
  expect(dirs).toContain(join("/cfg", "ravex-agents", "skills"))
  expect(dirs.some((path) => path.endsWith(join(".claude", "skills")))).toBe(true)
  expect(dirs.some((path) => path.endsWith(join(".codex", "skills")))).toBe(true)
})

test("names a plugin's skills after the plugin, so they don't clash", () => {
  const plain = join(dir, "plain")
  const plugin = join(dir, "plugin")
  mkdirSync(join(plain, "use"), { recursive: true })
  mkdirSync(join(plugin, "use"), { recursive: true })
  writeFileSync(join(plain, "use", "SKILL.md"), "---\ndescription: Plain\n---\nBody")
  writeFileSync(join(plugin, "use", "SKILL.md"), "---\ndescription: From a plugin\n---\nPlugin body")

  const library = new SkillLibrary([
    { path: plain, source: "agents" },
    { path: plugin, source: "claude", plugin: "figma" },
  ])
  expect(library.list().map((skill) => skill.name)).toEqual(["figma:use", "use"])
  expect(library.resolve(["figma:use"]).text).toContain("Plugin body")
})

function writeSkill(root: string, folder: string, title: string, body: string) {
  mkdirSync(join(dir, root, folder), { recursive: true })
  writeFileSync(join(dir, root, folder, "SKILL.md"), `---\nname: ${title}\ndescription: From ${root}\n---\n${body}`)
}

const merged = () =>
  new SkillLibrary([
    { path: join(dir, "repo"), source: "project" },
    { path: join(dir, "shared"), source: "agents" },
    { path: join(dir, "claude"), source: "claude" },
    { path: join(dir, "codex"), source: "codex" },
  ])

test("joins skills with the same title and shows where each was found", () => {
  writeSkill("claude", "write", "Write", "For Claude")
  writeSkill("codex", "write", "write", "For Codex")
  writeSkill("codex", "other", "Other", "Only Codex")
  const skills = merged().list()
  expect(skills.map((skill) => skill.name)).toEqual(["other", "write"])
  expect(skills[1]?.sources).toEqual(["claude", "codex"])
})

test("joins by title even when the folders are named differently", () => {
  writeSkill("claude", "a-folder", "Same Title", "One")
  writeSkill("codex", "b-folder", "Same Title", "One")
  const library = merged()
  expect(library.list().map((skill) => skill.name)).toEqual(["same-title"])
  expect(library.resolve(["same-title"]).text).toContain("One")
  expect(library.resolve(["b-folder"]).missing).toEqual([])
})

test("an agent gets its own CLI's version of a joined skill", () => {
  writeSkill("shared", "write", "write", "Shared")
  writeSkill("claude", "write", "write", "For Claude")
  writeSkill("codex", "write", "write", "For Codex")
  const library = merged()
  expect(library.resolve(["write"], "claude").text).toContain("For Claude")
  expect(library.resolve(["write"], "codex").text).toContain("For Codex")
  expect(library.resolve(["write"], "opencode").text).toContain("Shared")
  expect(library.resolve(["write"]).text).toContain("Shared")
})

test("a project's version comes before any CLI's", () => {
  writeSkill("codex", "write", "write", "For Codex")
  writeSkill("repo", "write", "write", "For this repo")
  expect(merged().resolve(["write"], "codex").text).toContain("For this repo")
})

test("copies with the same text count as one version", () => {
  writeSkill("shared", "write", "write", "Same")
  writeSkill("claude", "write", "write", "Same")
  writeSkill("codex", "write", "write", "Different")
  const library = merged()
  expect(library.list()[0]?.sources).toEqual(["agents", "claude", "codex"])
  expect(library.resolve(["write"], "claude").text).toContain("Same")
})
