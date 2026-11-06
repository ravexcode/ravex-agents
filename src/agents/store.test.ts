import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Provider, ProviderId } from "../providers/types.ts"
import { AgentStore, defaultAgentPaths, type AgentPaths } from "./store.ts"
import type { AgentDefinition } from "./types.ts"

const provider = (id: ProviderId, label: string): Provider => ({
  id,
  label,
  binary: id,
  buildArgs: () => [],
  parseLine: () => [],
})
const providers = [provider("claude", "Claude"), provider("codex", "Codex"), provider("opencode", "OpenCode")]

const definition = (id: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id,
  name: id,
  description: "",
  provider: "claude",
  instructions: "",
  mode: "read-only",
  ...overrides,
})

let dir: string
let paths: AgentPaths
let store: AgentStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravex-store-"))
  paths = { global: join(dir, "config", "agents.json"), project: join(dir, "project", ".ravex", "agents.json") }
  store = new AgentStore(paths, providers)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const writeRaw = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
const ids = () => store.load().agents.map((agent) => agent.id)
const find = (id: string) => store.load().agents.find((agent) => agent.id === id)

test("starts with a default orchestrator and one built-in agent per provider", () => {
  const { agents, errors, orchestratorId } = store.load()
  expect(agents.map((agent) => [agent.id, agent.origin])).toEqual([
    ["lead", "builtin"],
    ["claude", "builtin"],
    ["codex", "builtin"],
    ["opencode", "builtin"],
  ])
  expect(orchestratorId).toBe("lead")
  expect(errors).toEqual({})
  expect(existsSync(paths.global)).toBe(false)
})

test("editing a built-in agent overrides it, and deleting the copy restores it", () => {
  store.save(definition("codex", { provider: "codex", model: "gpt-6-sol" }), "global")
  expect(find("codex")).toMatchObject({ model: "gpt-6-sol", origin: "global" })
  store.delete("codex", "global")
  expect(find("codex")).toMatchObject({ origin: "builtin" })
  expect(find("codex")?.model).toBeUndefined()
})

test("keeps tools and skills, and refuses a file with an unknown tool", () => {
  store.save(definition("t", { tools: ["edit", "web"], skills: ["caveman"] }), "global")
  expect(find("t")).toMatchObject({ tools: ["edit", "web"], skills: ["caveman"] })

  writeRaw(paths.global, JSON.stringify({ agents: [{ ...definition("bad"), tools: ["laser"] }] }))
  expect(store.load().errors.global).toContain("invalid agent")
})

describe("orchestrator", () => {
  test("keeps the choice", () => {
    store.save(definition("boss"), "global")
    store.setOrchestrator("boss")
    expect(new AgentStore(paths, providers).load().orchestratorId).toBe("boss")
  })

  test("saving an agent doesn't lose the choice", () => {
    store.save(definition("boss"), "global")
    store.setOrchestrator("boss")
    store.save(definition("other"), "global")
    expect(store.load().orchestratorId).toBe("boss")
  })

  test("falls back to the default if the chosen agent no longer exists", () => {
    store.save(definition("boss"), "global")
    store.setOrchestrator("boss")
    store.delete("boss", "global")
    expect(store.load().orchestratorId).toBe("lead")
  })

  test("never overwrites an invalid file", () => {
    writeRaw(paths.global, "{ oops")
    expect(() => store.setOrchestrator("lead")).toThrow()
    expect(readFileSync(paths.global, "utf8")).toBe("{ oops")
  })
})

test("loads older files, and drops their subagents on the next save", () => {
  writeRaw(paths.global, JSON.stringify({ agents: [{ ...definition("old"), subagents: ["x"] }] }))
  expect(store.load().errors).toEqual({})
  expect(find("old")).toBeDefined()
  store.save(definition("new"), "global")
  expect(readFileSync(paths.global, "utf8")).not.toContain("subagents")
})

test("saves and reloads an agent with all of its fields", () => {
  const agent = definition("security", {
    description: "Audits",
    provider: "codex",
    model: "m1",
    instructions: 'Say "hi"\nnow',
    mode: "edit",
  })
  store.save(agent, "global")
  expect(new AgentStore(paths, providers).load().agents.at(-1)).toEqual({ ...agent, origin: "global" })
})

test("a project agent wins over a global agent with the same ID", () => {
  store.save(definition("a", { description: "global" }), "global")
  store.save(definition("a", { description: "project" }), "project")
  expect(find("a")).toMatchObject({ description: "project", origin: "project" })

  store.delete("a", "project")
  expect(find("a")).toMatchObject({ description: "global", origin: "global" })
})

test("editing replaces the agent instead of adding another", () => {
  store.save(definition("a"), "global")
  store.save(definition("a", { description: "new" }), "global")
  expect(ids().filter((id) => id === "a")).toHaveLength(1)
  expect(find("a")?.description).toBe("new")
})

test("changing an agent's origin moves it", () => {
  store.save(definition("a"), "global")
  store.save(definition("a"), "project", "global")
  expect(find("a")?.origin).toBe("project")
  store.delete("a", "project")
  expect(find("a")).toBeUndefined()
})

test("deleting removes only that agent", () => {
  store.save(definition("a"), "global")
  store.save(definition("b"), "global")
  store.delete("a", "global")
  expect(ids()).toEqual(["lead", "claude", "codex", "opencode", "b"])
})

test("leaves no temporary files behind", () => {
  store.save(definition("a"), "global")
  expect(readdirSync(dirname(paths.global))).toEqual(["agents.json"])
})

describe("invalid files", () => {
  const corrupt = '{"agents": [ oops'

  test("are reported without hiding the other origin's agents", () => {
    store.save(definition("project-agent"), "project")
    writeRaw(paths.global, corrupt)
    const { agents, errors } = store.load()
    expect(errors.global).toContain(paths.global)
    expect(errors.project).toBeUndefined()
    expect(agents.map((agent) => agent.id)).toContain("project-agent")
  })

  test("are never overwritten by saving or deleting", () => {
    writeRaw(paths.global, corrupt)
    expect(() => store.save(definition("a"), "global")).toThrow()
    expect(() => store.delete("a", "global")).toThrow()
    expect(readFileSync(paths.global, "utf8")).toBe(corrupt)
  })

  test("block a move before changing either file", () => {
    store.save(definition("a"), "project")
    writeRaw(paths.global, corrupt)
    const before = readFileSync(paths.project, "utf8")
    expect(() => store.save(definition("a"), "global", "project")).toThrow()
    expect(readFileSync(paths.project, "utf8")).toBe(before)
  })

  test("include valid JSON with the wrong shape or unknown provider", () => {
    writeRaw(paths.global, JSON.stringify({ wrong: true }))
    expect(store.load().errors.global).toContain("agents")

    writeRaw(paths.global, JSON.stringify({ agents: [definition("a", { provider: "nope" as ProviderId })] }))
    expect(store.load().errors.global).toContain("invalid agent")

    writeRaw(paths.global, JSON.stringify({ agents: [{ id: "a" }] }))
    expect(store.load().errors.global).toContain("invalid agent")
  })
})

describe("defaultAgentPaths", () => {
  test("uses XDG_CONFIG_HOME when set, and the project's folder", () => {
    expect(defaultAgentPaths("/repo", { XDG_CONFIG_HOME: "/xdg" })).toEqual({
      global: "/xdg/ravex-agents/agents.json",
      project: "/repo/.ravex/agents.json",
    })
  })

  test("falls back to the home config folder", () => {
    expect(defaultAgentPaths("/repo", {}).global).toEndWith("/.config/ravex-agents/agents.json")
  })
})
