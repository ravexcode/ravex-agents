import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { AgentStore, type AgentPaths } from "./agents/store.ts"
import { App } from "./app.tsx"
import { Orchestrator } from "./orchestrator.ts"
import type { RunTurn } from "./providers/runner.ts"
import type { Provider, ProviderId } from "./providers/types.ts"

// Longer than the orchestrator's notification batching, so updates land inside act().
const SETTLE_MS = 60
// A lone Esc byte is held briefly in case it starts an escape sequence.
const ESCAPE_SETTLE_MS = 300

const fake = (id: ProviderId, label: string): Provider => ({
  id,
  label,
  binary: id,
  buildArgs: () => [],
  parseLine: () => [],
})
const providers = [fake("claude", "Claude"), fake("codex", "Codex"), fake("opencode", "OpenCode")]

let dir: string
let paths: AgentPaths

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravex-app-"))
  paths = { global: join(dir, "config", "agents.json"), project: join(dir, "project", ".ravex", "agents.json") }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const savedAgents = (path = paths.global) => JSON.parse(readFileSync(path, "utf8")).agents

async function setup(width: number) {
  const prompts: { id: string; prompt: string; mode: string; instructions?: string }[] = []
  const signals: AbortSignal[] = []
  const run: RunTurn = (provider, request, onEvent, signal) => {
    prompts.push({
      id: provider.id,
      prompt: request.prompt,
      mode: request.mode,
      instructions: request.instructions,
    })
    signals.push(signal)
    onEvent({ type: "text-delta", text: `reply from ${provider.label}` })
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ status: "cancelled" }))
    })
  }
  const store = new AgentStore(paths, providers)
  const { agents, errors } = store.load()
  const orchestrator = new Orchestrator(providers, agents, {
    run,
    isAvailable: (provider) => provider.id !== "opencode",
  })

  let view!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    view = await testRender(
      <App
        orchestrator={orchestrator}
        store={store}
        providerIds={providers.map((provider) => provider.id)}
        initialErrors={errors}
      />,
      { width, height: 28 },
    )
  })

  const frame = async () => {
    await act(async () => {
      await view.renderOnce()
    })
    return view.captureCharFrame()
  }
  const press = (
    key: Parameters<typeof view.mockInput.pressKey>[0],
    modifiers?: { ctrl?: boolean; shift?: boolean },
    settleMs = SETTLE_MS,
  ) =>
    act(async () => {
      view.mockInput.pressKey(key, modifiers)
      await Bun.sleep(settleMs)
    })
  const arrow = (direction: "up" | "down" | "left" | "right") =>
    act(async () => {
      view.mockInput.pressArrow(direction)
      await Bun.sleep(SETTLE_MS)
    })
  const type = (text: string) =>
    act(async () => {
      await view.mockInput.typeText(text)
      await Bun.sleep(SETTLE_MS)
    })
  const submit = (text: string) =>
    act(async () => {
      await view.mockInput.typeText(text)
      view.mockInput.pressEnter()
      await Bun.sleep(SETTLE_MS)
    })
  const tabs = async (count: number) => {
    for (let i = 0; i < count; i++) await press("TAB")
  }

  return { view, prompts, signals, frame, press, arrow, type, submit, tabs, orchestrator }
}

async function withApp(body: (app: Awaited<ReturnType<typeof setup>>) => Promise<void>, width = 120) {
  const app = await setup(width)
  try {
    await body(app)
  } finally {
    await act(async () => {
      app.view.renderer.destroy()
    })
  }
}

type App = Awaited<ReturnType<typeof setup>>

/** Fills the name field of a new agent, optionally starting from a template. */
async function openNewAgent(app: App, name: string, templateSteps = 0) {
  await app.press("n", { ctrl: true })
  for (let i = 0; i < templateSteps; i++) await app.arrow("right")
  await app.tabs(1)
  if (name) await app.type(name)
}

async function createAgent(app: App, name: string) {
  await openNewAgent(app, name)
  await app.press("s", { ctrl: true })
}

test("shows all agents in the tree and in columns, flagging a missing CLI", () =>
  withApp(async ({ frame }) => {
    const screen = await frame()
    expect(screen).toContain(" Agents ")
    expect(screen).toContain("▸ All")
    expect(screen).toContain("Claude · idle")
    expect(screen).toContain("Codex · idle")
    expect(screen).toContain("OpenCode · not installed")
    expect(screen).toContain("To: All (3)")
    expect(screen).toContain("READ-ONLY")
  }))

test("sends a prompt to all agents and shows each reply", () =>
  withApp(async ({ prompts, frame, submit }) => {
    await submit("hello")
    expect(prompts.map((p) => p.id)).toEqual(["claude", "codex"])
    const screen = await frame()
    expect(screen).toContain("reply from Claude")
    expect(screen).toContain("reply from Codex")
    // The narrow column wraps the rest of this message onto another line.
    expect(screen).toContain("opencode was not found")
  }))

test("Tab selects one agent, and typing q doesn't quit", () =>
  withApp(async ({ view, prompts, frame, tabs, submit }) => {
    await tabs(2)
    const screen = await frame()
    expect(screen).toContain("To: Codex")
    expect(screen).toContain("▸ Codex")
    expect(screen).not.toContain("Claude · idle")

    await submit("q")
    expect(view.renderer.isDestroyed).toBe(false)
    expect(prompts).toEqual([{ id: "codex", prompt: "q", mode: "read-only", instructions: undefined }])
  }))

test("Shift+Tab goes backwards", () =>
  withApp(async ({ frame, press }) => {
    await press("TAB", { shift: true })
    expect(await frame()).toContain("To: OpenCode")
  }))

test("clears the input after sending, even when Enter follows typing immediately", () =>
  withApp(async ({ view, prompts, frame, tabs, type }) => {
    await tabs(1)
    await act(async () => {
      await view.mockInput.typeText("first")
      view.mockInput.pressEnter()
      await view.mockInput.typeText("second")
      view.mockInput.pressEnter()
      await Bun.sleep(SETTLE_MS)
    })
    expect(prompts.map((p) => p.prompt)).toEqual(["first"])
    expect(await frame()).toContain("Still running")
    await type("third")
    const inputLine = (await frame()).split("\n").find((line) => line.includes("third"))
    expect(inputLine).not.toContain("first")
    expect(inputLine).not.toContain("second")
  }))

test("Esc cancels the target and Ctrl+E switches the mode", () =>
  withApp(async ({ prompts, signals, frame, press, submit }) => {
    await press("e", { ctrl: true })
    expect(await frame()).toContain("EDIT")

    await submit("change it")
    expect(prompts[0]?.mode).toBe("edit")

    await press("ESCAPE", undefined, ESCAPE_SETTLE_MS)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(await frame()).toContain("Claude · cancelled")
  }))

test("hides the tree and stacks panes on narrow terminals", () =>
  withApp(async ({ frame }) => {
    const screen = await frame()
    expect(screen).not.toContain(" Agents ")
    const lines = screen.split("\n")
    const row = (label: string) => lines.findIndex((line) => line.includes(label))
    expect(row("Claude ·")).toBeLessThan(row("Codex ·"))
    expect(row("Codex ·")).toBeLessThan(row("OpenCode ·"))
  }, 50))

test("creates an agent from the keyboard, saves it and selects it", () =>
  withApp(async (app) => {
    await app.press("n", { ctrl: true })
    expect(await app.frame()).toContain("New agent")

    await app.tabs(1)
    await app.type("Diseño UX")
    await app.tabs(1)
    await app.type("Reviews interfaces")
    await app.tabs(1)
    await app.arrow("right")
    await app.tabs(1)
    await app.type("m1")
    await app.tabs(3)
    await app.type("Be specific")
    await app.press("s", { ctrl: true })

    expect(savedAgents()).toEqual([
      {
        id: "diseno-ux",
        name: "Diseño UX",
        description: "Reviews interfaces",
        provider: "codex",
        model: "m1",
        instructions: "Be specific",
        mode: "read-only",
        subagents: [],
      },
    ])
    const screen = await app.frame()
    expect(screen).not.toContain("New agent")
    expect(screen).toContain("To: Diseño UX")
    expect(screen).toContain("▸ Diseño UX")
    expect(screen).toContain("codex/m1")

    await app.submit("hi")
    expect(app.prompts).toEqual([{ id: "codex", prompt: "hi", mode: "read-only", instructions: "Be specific" }])
  }))

test("a template fills the form, including the cybersecurity one", () =>
  withApp(async (app) => {
    await app.press("n", { ctrl: true })
    await app.arrow("right")
    let screen = await app.frame()
    expect(screen).toContain("Cybersecurity")
    expect(screen).toContain("Security")
    await app.arrow("right")
    screen = await app.frame()
    expect(screen).toContain("product designer")
    await app.arrow("left")
    await app.press("s", { ctrl: true })

    const [saved] = savedAgents()
    expect(saved.id).toBe("security")
    expect(saved.mode).toBe("read-only")
    expect(saved.instructions).toContain("application security specialist")
  }))

test("long instructions stay inside the form's border", () =>
  withApp(async (app) => {
    await app.press("n", { ctrl: true })
    await app.arrow("right")
    const lines = (await app.frame()).split("\n").filter((line) => line.startsWith("│"))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toEndWith("│")
  }))

test("the subagent list uses the free space and says when there are more", async () => {
  const definition = (position: number) => ({
    id: `agent-${position}`,
    name: `Agent ${position}`,
    description: "",
    provider: "claude",
    instructions: "",
    mode: "read-only",
    subagents: [],
  })
  mkdirSync(dirname(paths.global), { recursive: true })
  writeFileSync(paths.global, JSON.stringify({ agents: Array.from({ length: 30 }, (_, i) => definition(i)) }))

  await withApp(async (app) => {
    await app.press("n", { ctrl: true })
    await app.press("TAB", { shift: true })
    let screen = await app.frame()
    expect(screen).toContain("[ ] Agent 5")
    expect(screen).toContain("1/33")
    expect(screen).not.toContain("Agent 29")

    await app.arrow("up")
    screen = await app.frame()
    expect(screen).toContain("[ ] Agent 29")
    expect(screen).toContain("33/33")
  })
})

test("shows validation errors and keeps the form open", () =>
  withApp(async (app) => {
    await app.press("n", { ctrl: true })
    await app.press("s", { ctrl: true })
    expect(await app.frame()).toContain("Name is required")

    await app.tabs(1)
    await app.type("Claude")
    await app.press("s", { ctrl: true })
    const screen = await app.frame()
    expect(screen).toContain("already exists")
    expect(screen).toContain("New agent")
  }))

test("Esc leaves the form without saving", () =>
  withApp(async (app) => {
    await openNewAgent(app, "Nope")
    await app.press("ESCAPE", undefined, ESCAPE_SETTLE_MS)
    expect(await app.frame()).not.toContain("New agent")
    expect(() => savedAgents()).toThrow()
  }))

test("assigns a subagent, which then nests under its parent and receives delegations", () =>
  withApp(async (app) => {
    await createAgent(app, "Security")
    await openNewAgent(app, "Lead")
    // From Name: description, provider, model, mode, origin, instructions, subagents.
    await app.tabs(7)
    // The candidates are Claude, Codex, OpenCode and Security.
    await app.arrow("up")
    await app.press(" ")
    expect(await app.frame()).toContain("[x] Security")
    await app.press("s", { ctrl: true })

    expect(savedAgents().find((a: { id: string }) => a.id === "lead").subagents).toEqual(["security"])
    const lines = (await app.frame()).split("\n")
    const lead = lines.findIndex((line) => line.includes("▸ Lead"))
    expect(lines[lead + 1]).toContain("└ Security")
    expect(await app.frame()).toContain("To: Lead")
  }))

test("Tab follows the tree's order rather than the order agents were created in", () =>
  withApp(async (app) => {
    await createAgent(app, "Child")
    await openNewAgent(app, "Parent")
    await app.tabs(7)
    await app.arrow("up")
    await app.press(" ")
    await app.press("s", { ctrl: true })
    expect(await app.frame()).toContain("To: Parent")

    await app.tabs(1)
    expect(await app.frame()).toContain("To: Child")
    await app.tabs(1)
    expect(await app.frame()).toContain("To: All")
    await app.press("TAB", { shift: true })
    expect(await app.frame()).toContain("To: Child")
  }))

test("rejects an assignment that would create a cycle", () =>
  withApp(async (app) => {
    await createAgent(app, "One")
    await openNewAgent(app, "Two")
    await app.tabs(7)
    await app.arrow("up")
    await app.press(" ")
    await app.press("s", { ctrl: true })

    await app.tabs(1)
    expect(await app.frame()).toContain("To: One")
    await app.press("o", { ctrl: true })
    await app.tabs(7)
    await app.arrow("up")
    await app.press(" ")
    await app.press("s", { ctrl: true })
    const screen = await app.frame()
    expect(screen).toContain("cycle")
    expect(screen).toContain("Edit One")
  }))

test("edits an agent and can move it to the project", () =>
  withApp(async (app) => {
    await createAgent(app, "Worker")
    await app.press("o", { ctrl: true })
    const form = await app.frame()
    expect(form).toContain("Edit Worker")
    expect(form).not.toContain("Template")

    await app.tabs(5)
    await app.arrow("right")
    await app.press("s", { ctrl: true })

    expect(savedAgents()).toEqual([])
    expect(savedAgents(paths.project)[0].id).toBe("worker")
    expect(await app.frame()).toContain("Worker ·p")
  }))

test("deletes an agent only after confirmation", () =>
  withApp(async (app) => {
    await createAgent(app, "Temp")
    await app.press("x", { ctrl: true })
    expect(await app.frame()).toContain("Delete Temp?")
    await app.press("n")
    expect(savedAgents()).toHaveLength(1)
    expect(await app.frame()).toContain("▸ Temp")

    await app.press("x", { ctrl: true })
    await app.press("y")
    expect(savedAgents()).toEqual([])
    const screen = await app.frame()
    expect(screen).toContain("Deleted Temp")
    expect(screen).toContain("▸ All")
  }))

test("typing y or n while confirming doesn't reach the prompt input", () =>
  withApp(async (app) => {
    await createAgent(app, "Temp")
    await app.press("x", { ctrl: true })
    await app.press("n")
    const inputLine = (await app.frame()).split("\n").find((line) => line.includes("To: Temp"))
    const row = (await app.frame()).split("\n")
    expect(row[row.indexOf(inputLine ?? "") + 1]).toContain("Send a prompt")
  }))

test("built-in agents can't be edited or deleted", () =>
  withApp(async (app) => {
    await app.tabs(1)
    await app.press("o", { ctrl: true })
    expect(await app.frame()).toContain("is built in")
    await app.press("x", { ctrl: true })
    const screen = await app.frame()
    expect(screen).toContain("is built in")
    expect(screen).not.toContain("Delete Claude?")
  }))

test("an agent that's running can't be edited or deleted", () =>
  withApp(async (app) => {
    await createAgent(app, "Busy")
    await app.submit("work")
    await app.press("x", { ctrl: true })
    const screen = await app.frame()
    expect(screen).toContain("Busy is running")
    expect(screen).not.toContain("Delete Busy?")
  }))

test("reports a corrupt file, keeps it intact and blocks saving to it", async () => {
  mkdirSync(dirname(paths.global), { recursive: true })
  writeFileSync(paths.global, "{ oops")
  await withApp(async (app) => {
    expect(await app.frame()).toContain("Not loaded, and saving is blocked")
    await createAgent(app, "New")
    const screen = await app.frame()
    expect(screen).toContain("Couldn't save to global")
    expect(screen).toContain("New agent")
    expect(readFileSync(paths.global, "utf8")).toBe("{ oops")
  })
})

test("loads saved agents from both origins on startup", async () => {
  const definition = (id: string) => ({
    id,
    name: id,
    description: "",
    provider: "claude",
    instructions: "",
    mode: "read-only",
    subagents: [],
  })
  mkdirSync(dirname(paths.global), { recursive: true })
  mkdirSync(dirname(paths.project), { recursive: true })
  writeFileSync(paths.global, JSON.stringify({ agents: [definition("from-global")] }))
  writeFileSync(paths.project, JSON.stringify({ agents: [definition("from-project")] }))
  await withApp(async (app) => {
    const screen = await app.frame()
    expect(screen).toContain("from-global")
    expect(screen).toContain("from-project ·p")
  })
})
