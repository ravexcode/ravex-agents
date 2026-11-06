import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { Skill } from "./agents/skills.ts"
import { AgentStore, type AgentPaths } from "./agents/store.ts"
import { App } from "./app.tsx"
import { Team } from "./core/team.ts"
import type { ListModels } from "./providers/models.ts"
import type { RunTurn, TurnResult } from "./providers/runner.ts"
import type { Provider, ProviderEvent, ProviderId, ToolId, TurnRequest } from "./providers/types.ts"

// Longer than the team's notification batching, so updates land inside act().
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
const providers = [
  fake("claude", "Claude"),
  { ...fake("codex", "Codex"), lockedTools: ["shell", "mcp"] as ToolId[] },
  fake("opencode", "OpenCode"),
]
const skills: Skill[] = [
  { name: "caveman", description: "Talk less", path: "/s/caveman/SKILL.md" },
  { name: "clean-code", description: "Write clean code", path: "/s/clean-code/SKILL.md" },
  { name: "go-testing", description: "Test Go code", path: "/s/go-testing/SKILL.md" },
]
const listSkills = () => skills

let dir: string
let paths: AgentPaths

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravex-app-"))
  paths = { global: join(dir, "config", "agents.json"), project: join(dir, "project", ".ravex", "agents.json") }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const savedFile = (path = paths.global) => JSON.parse(readFileSync(path, "utf8"))

interface Call {
  provider: string
  request: TurnRequest
  emit: (event: ProviderEvent) => void
  finish: (result?: TurnResult) => void
  signal: AbortSignal
}

const defaultModels: ListModels = async (provider) =>
  provider === "claude" ? ["fable", "opus", "sonnet", "haiku"] : ["openai/gpt-5.5", "zai/glm-5", "ollama/bonsai"]

async function setup(width = 100, listModels: ListModels = defaultModels, height = 30) {
  const calls: Call[] = []
  const run: RunTurn = (provider, request, onEvent, signal) =>
    new Promise((resolve) => {
      calls.push({
        provider: provider.id,
        request,
        emit: onEvent,
        finish: (result = { status: "done" }) => resolve(result),
        signal,
      })
      signal.addEventListener("abort", () => resolve({ status: "cancelled" }))
    })
  const store = new AgentStore(paths, providers)
  const { agents, orchestratorId, errors } = store.load()
  const team = new Team(providers, agents, orchestratorId, { run, isAvailable: () => true })

  let view!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    view = await testRender(
      <App
        team={team}
        store={store}
        providers={providers}
        listModels={listModels}
        listSkills={listSkills}
        initialErrors={errors}
      />,
      { width, height },
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
  /** Sends the exact bytes a terminal would, for keys it can encode in several ways. */
  const send = (sequence: string) =>
    act(async () => {
      view.renderer.stdin.emit("data", Buffer.from(sequence))
      await Bun.sleep(SETTLE_MS)
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
  const enter = () =>
    act(async () => {
      view.mockInput.pressEnter()
      await Bun.sleep(SETTLE_MS)
    })
  const escape = () => press("ESCAPE", undefined, ESCAPE_SETTLE_MS)
  const reply = (call: Call, text: string) =>
    act(async () => {
      call.emit({ type: "text-start" })
      call.emit({ type: "text-delta", text })
      call.finish()
      await Bun.sleep(SETTLE_MS)
    })

  return {
    view,
    team,
    calls,
    frame,
    press,
    send,
    arrow,
    type,
    enter,
    escape,
    reply,
    destroy: () =>
      act(async () => {
        team.stop()
        view.renderer.destroy()
      }),
  }
}

type Ctx = Awaited<ReturnType<typeof setup>>

async function withApp(body: (ctx: Ctx) => Promise<void>, width?: number, listModels?: ListModels, height?: number) {
  const ctx = await setup(width, listModels, height)
  try {
    await body(ctx)
  } finally {
    await ctx.destroy()
  }
}

const plan = (tasks: object[]) => `Here is the work.\n\`\`\`ravex-plan\n${JSON.stringify({ tasks })}\n\`\`\``
const task = (key: string, agent: string, overrides: object = {}) => ({
  key,
  title: `Task ${key}`,
  description: `do ${key}`,
  agent,
  ...overrides,
})

async function propose(ctx: Ctx, tasks: object[]) {
  await ctx.type("Add rate limiting")
  await ctx.enter()
  await ctx.reply(ctx.calls.at(-1) as Call, plan(tasks))
}

test("opens on the orchestrator's chat, with no boxes and no empty panels", () =>
  withApp(async ({ frame }) => {
    const screen = await frame()
    expect(screen).toContain("Orchestrator  Room  Claude  Codex  OpenCode")
    expect(screen).toContain("READ-ONLY")
    expect(screen).toContain("Lead · claude · idle")
    expect(screen).toContain("Describe a goal for the orchestrator")
    expect(screen).not.toContain("Tasks")
    expect(screen).not.toMatch(/[┌┐└┘│─]/)
    // The orchestrator is its own tab, not also an agent.
    expect(screen.split("\n")[0]).not.toContain("Lead")
  }))

test("no screen draws a box", () =>
  withApp(async (ctx) => {
    await propose(ctx, [task("a", "codex")])
    expect(await ctx.frame()).not.toMatch(/[┌┐└┘│─]/)
    await ctx.press("t", { ctrl: true })
    await ctx.enter()
    expect(await ctx.frame()).not.toMatch(/[┌┐└┘│─]/)
    await ctx.escape()
    await ctx.escape()
    await ctx.press("TAB")
    expect(await ctx.frame()).not.toMatch(/[┌┐└┘│─]/)
    await ctx.press("g", { ctrl: true })
    expect(await ctx.frame()).not.toMatch(/[┌┐└┘│─]/)
    await ctx.type("n")
    expect(await ctx.frame()).not.toMatch(/[┌┐└┘│─]/)
  }))

test("a goal becomes a proposal, and nothing runs until Enter approves it", () =>
  withApp(async (ctx) => {
    await ctx.type("Add rate limiting")
    await ctx.enter()
    expect(ctx.calls.length).toBe(1)
    expect(ctx.calls[0]?.request.prompt).toBe("Add rate limiting")
    expect(await ctx.frame()).toContain("> Add rate limiting")

    await ctx.reply(ctx.calls[0] as Call, plan([task("a", "codex"), task("b", "opencode", { dependsOn: ["a"], edits: true })]))
    let screen = await ctx.frame()
    expect(screen).toContain("Here is the work.")
    expect(screen).not.toContain("ravex-plan")
    expect(screen).toContain("Tasks")
    expect(screen).toContain("○  1 Task a")
    expect(screen).toContain("○  2 Task b")
    expect(screen).toContain("← waits for 1")
    expect(screen).toContain("Enter approve")
    expect(screen).toContain("Approving doesn't grant permissions")
    expect(ctx.calls.length).toBe(1)

    await ctx.enter()
    screen = await ctx.frame()
    expect(ctx.calls.length).toBe(2)
    expect(ctx.calls[1]?.provider).toBe("codex")
    expect(screen).toContain("●  1 Task a")
    expect(screen).toContain("Approving doesn't grant permissions")
  }))

test("Esc discards a proposal, and an empty Enter does nothing without one", () =>
  withApp(async (ctx) => {
    await ctx.enter()
    expect(ctx.calls.length).toBe(0)

    await propose(ctx, [task("a", "codex")])
    await ctx.escape()
    const screen = await ctx.frame()
    expect(screen).toContain("Plan discarded.")
    expect(screen).not.toContain("Tasks")
    await ctx.enter()
    expect(ctx.calls.length).toBe(1)
  }))

test("typing on a proposal asks for a new plan", () =>
  withApp(async (ctx) => {
    await propose(ctx, [task("a", "codex")])
    await ctx.type("use opencode instead")
    await ctx.enter()
    expect(ctx.calls.length).toBe(2)
    expect(ctx.calls[1]?.request.prompt).toContain("use opencode instead")
    expect(ctx.calls[1]?.request.mode).toBe("read-only")
  }))

test("the input clears, even when Enter comes right after typing", () =>
  withApp(async (ctx) => {
    await ctx.press("TAB")
    await ctx.type("hello room")
    await ctx.enter()
    await ctx.type("another")
    await ctx.enter()
    const screen = await ctx.frame()
    expect(screen).toContain("> hello room")
    expect(screen).toContain("> another")
    expect(screen).not.toContain("hello roomanother")
  }))

test("Ctrl+T says so when there are no tasks", () =>
  withApp(async (ctx) => {
    await ctx.press("t", { ctrl: true })
    expect(await ctx.frame()).toContain("No tasks yet.")
    await ctx.type("still typing")
    expect(await ctx.frame()).toContain("still typing")
  }))

test("the task panel moves, reassigns and opens a task", () =>
  withApp(async (ctx) => {
    await propose(ctx, [task("a", "codex", { edits: true }), task("b", "opencode")])

    await ctx.press("t", { ctrl: true })
    let screen = await ctx.frame()
    expect(screen).toContain("▸○  1 Task a")
    expect(screen).toContain("r reassign")

    await ctx.arrow("down")
    screen = await ctx.frame()
    expect(screen).toContain("▸○  2 Task b")

    // Keys here belong to the panel, not to the input.
    await ctx.type("r")
    expect(ctx.team.getState().board.tasks[1]?.assignee).toBe("claude")
    expect(await ctx.frame()).not.toContain("› r")

    await ctx.arrow("up")
    await ctx.enter()
    screen = await ctx.frame()
    expect(screen).toContain("Task 1 · proposed")
    expect(screen).toContain("do a")
    expect(screen).toContain("Assigned to Codex · edits files")
    expect(ctx.calls.length).toBe(1)

    await ctx.type("mind the tests")
    await ctx.enter()
    screen = await ctx.frame()
    expect(screen).toContain("You: mind the tests")
    expect(ctx.team.getState().board.tasks[0]?.comments).toEqual([{ author: "you", text: "mind the tests" }])

    await ctx.escape()
    screen = await ctx.frame()
    expect(screen).toContain("Task a")
    expect(screen).toContain("r reassign")
    await ctx.escape()
    expect(await ctx.frame()).toContain("Enter approve")
  }))

test("a task's detail shows its result and the agent's conversation", () =>
  withApp(async (ctx) => {
    await propose(ctx, [task("a", "codex")])
    await ctx.enter()
    const work = ctx.calls.at(-1) as Call
    await act(async () => {
      work.emit({ type: "tool", name: "read", detail: "src/x.ts" })
      await Bun.sleep(SETTLE_MS)
    })
    await ctx.reply(work, "Found two bugs")

    await ctx.press("t", { ctrl: true })
    await ctx.enter()
    const screen = await ctx.frame()
    expect(screen).toContain("Task 1 · done")
    expect(screen).toContain("Result")
    expect(screen).toContain("Found two bugs")
    expect(screen).toContain("Agent conversation")
    expect(screen).toContain("read: src/x.ts")
  }))

test("Tab goes through the orchestrator, the room and each agent", () =>
  withApp(async (ctx) => {
    await ctx.press("TAB")
    let screen = await ctx.frame()
    expect(screen).toContain("Team room")
    expect(screen).toContain("Message the room")

    await ctx.press("TAB")
    screen = await ctx.frame()
    expect(screen).toContain("Claude · claude · idle")
    expect(screen).toContain("Message Claude")

    await ctx.press("TAB", { shift: true })
    await ctx.press("TAB", { shift: true })
    expect(await ctx.frame()).toContain("Describe a goal")

    await ctx.press("TAB", { shift: true })
    expect(await ctx.frame()).toContain("Message OpenCode")
  }))

test("in the room, only a mention spends anything", () =>
  withApp(async (ctx) => {
    await ctx.press("TAB")
    await ctx.type("hello")
    await ctx.enter()
    let screen = await ctx.frame()
    expect(screen).toContain("Nobody replies without a mention")
    expect(ctx.calls.length).toBe(0)

    await ctx.type("@codex what do you think")
    await ctx.enter()
    expect(ctx.calls.length).toBe(1)
    expect(ctx.calls[0]?.request.mode).toBe("read-only")
    expect(await ctx.frame()).toContain("Codex is replying…")

    await ctx.reply(ctx.calls[0] as Call, "Sounds good")
    screen = await ctx.frame()
    expect(screen).toContain("Codex: Sounds good")
    expect(screen).not.toContain("is replying")
  }))

const emit = (call: Call, ...events: ProviderEvent[]) =>
  act(async () => {
    for (const event of events) call.emit(event)
    await Bun.sleep(SETTLE_MS)
  })

test("a conversation shows thinking, tools and the reply as they arrive", () =>
  withApp(async (ctx) => {
    await ctx.type("Look around")
    await ctx.enter()
    const call = ctx.calls[0] as Call
    expect(await ctx.frame()).toContain("Working…")

    await emit(call, { type: "thinking-start" })
    expect(await ctx.frame()).toContain("Thinking…")
    await emit(call, { type: "thinking-delta", text: "Maybe the " }, { type: "thinking-delta", text: "tests" })
    expect(await ctx.frame()).toContain("✻ Maybe the tests")

    await emit(call, { type: "tool", name: "Read", detail: "a.ts" })
    let screen = await ctx.frame()
    expect(screen).toContain("◆ Read: a.ts")
    expect(screen).toContain("Running Read…")
    await emit(call, { type: "tool-end" })
    expect(await ctx.frame()).toContain("Working…")

    await emit(call, { type: "text-start" }, { type: "text-delta", text: "Half a " })
    screen = await ctx.frame()
    expect(screen).toContain("Half a")
    expect(screen).toContain("Responding…")
    await emit(call, { type: "text-delta", text: "reply" })
    expect(await ctx.frame()).toContain("Half a reply")

    await act(async () => {
      call.finish()
      await Bun.sleep(SETTLE_MS)
    })
    screen = await ctx.frame()
    expect(screen).toContain("✻ Maybe the tests")
    expect(screen).not.toContain("Responding…")
  }))

test("thinking without text only changes the spinner", () =>
  withApp(async (ctx) => {
    await ctx.type("Look around")
    await ctx.enter()
    await emit(ctx.calls[0] as Call, { type: "thinking-start" }, { type: "thinking-delta", text: "" })
    const screen = await ctx.frame()
    expect(screen).toContain("Thinking…")
    expect(screen).not.toContain("✻")
  }))

test("thinking is never taken for the agent's answer", () =>
  withApp(async (ctx) => {
    await ctx.type("Add rate limiting")
    await ctx.enter()
    const call = ctx.calls[0] as Call
    await emit(call, { type: "thinking-delta", text: "Let me plan" })
    await ctx.reply(call, plan([task("a", "codex")]))
    expect(await ctx.frame()).toContain("Proposed 1 task")
  }))

test("a team block stays hidden while it's being written", () =>
  withApp(async (ctx) => {
    await ctx.type("Add rate limiting")
    await ctx.enter()
    await emit(ctx.calls[0] as Call, { type: "text-start" }, { type: "text-delta", text: 'Here.\n```ravex-plan\n{"tasks":' })
    const screen = await ctx.frame()
    expect(screen).toContain("Here.")
    expect(screen).not.toContain("ravex-plan")
    expect(screen).not.toContain('{"tasks"')
  }))

test("the room shows a reply as it arrives", () =>
  withApp(async (ctx) => {
    await ctx.press("TAB")
    await ctx.type("@codex what do you think")
    await ctx.enter()
    const call = ctx.calls[0] as Call
    await emit(call, { type: "text-start" }, { type: "text-delta", text: "So far" })
    expect(await ctx.frame()).toContain("Codex: So far")
    await emit(call, { type: "text-delta", text: " so good" })
    await act(async () => {
      call.finish()
      await Bun.sleep(SETTLE_MS)
    })
    const screen = await ctx.frame()
    expect(screen).toContain("Codex: So far so good")
    expect(screen).not.toContain("is replying")
  }))

const BRAILLE = /[\u2801-\u28ff]/

test("the logo sits behind the conversation, and text covers it", () =>
  withApp(async (ctx) => {
    expect(await ctx.frame()).toMatch(BRAILLE)

    const words = Array.from({ length: 300 }, () => "word").join(" ")
    await ctx.type("Look around")
    await ctx.enter()
    await emit(ctx.calls[0] as Call, { type: "text-start" }, { type: "text-delta", text: words })
    const lines = (await ctx.frame()).split("\n").filter((line) => line.includes("word"))
    expect(lines.length).toBeGreaterThan(5)
    for (const line of lines) expect(line).not.toMatch(BRAILLE)
  }))

test("the logo leaves when there's no room for it", () =>
  withApp(
    async (ctx) => {
      expect(await ctx.frame()).not.toMatch(BRAILLE)
    },
    30,
    undefined,
    10,
  ))

test("a room turn of the orchestrator stays out of its chat", () =>
  withApp(async (ctx) => {
    await ctx.press("TAB")
    await ctx.type("@lead how is it going")
    await ctx.enter()
    await ctx.reply(ctx.calls[0] as Call, "All good")
    expect(await ctx.frame()).toContain("Lead: All good")
    await ctx.press("TAB", { shift: true })
    const screen = await ctx.frame()
    expect(screen).not.toContain("All good")
    expect(screen).not.toContain("Mentioned in the room")
  }))

test("a direct message goes to that agent, and Esc cancels it", () =>
  withApp(async (ctx) => {
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.type("hi claude")
    await ctx.enter()
    expect(ctx.calls[0]?.request.prompt).toBe("hi claude")
    expect((await ctx.frame()).split("\n")[0]).toContain("● Claude")
    await ctx.escape()
    expect(ctx.calls[0]?.signal.aborted).toBe(true)
  }))

test("Esc on running work stops it, then a second Esc on the pause closes the goal", () =>
  withApp(async (ctx) => {
    await propose(ctx, [task("a", "codex"), task("b", "opencode", { dependsOn: ["a"] })])
    await ctx.enter()
    await ctx.escape()
    expect(ctx.calls.at(-1)?.signal.aborted).toBe(true)
    let screen = await ctx.frame()
    expect(screen).toContain("Work stopped")
    expect(screen).toContain("–  1 Task a")

    await ctx.escape()
    screen = await ctx.frame()
    expect(screen).toContain("Press Esc again")
    expect(ctx.team.getState().board.phase).toBe("paused")

    await ctx.escape()
    expect(ctx.team.getState().board.phase).toBe("idle")
    screen = await ctx.frame()
    expect(screen).toContain("–  2 Task b")
    expect(screen).not.toContain("Press Esc again")
  }))

test("Ctrl+E changes the session's mode", () =>
  withApp(async (ctx) => {
    await ctx.press("e", { ctrl: true })
    expect((await ctx.frame()).split("\n")[0]).toContain("EDIT")
    await ctx.press("e", { ctrl: true })
    expect(await ctx.frame()).toContain("READ-ONLY")
  }))

test("PageUp scrolls a long conversation, and it stays on screen without a scrollbar", () =>
  withApp(async (ctx) => {
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.type("hi")
    await ctx.enter()
    const lines = Array.from({ length: 60 }, (_, index) => `line-${index}`).join("\n")
    await ctx.reply(ctx.calls[0] as Call, lines)
    let screen = await ctx.frame()
    expect(screen).toContain("line-59")
    expect(screen).not.toContain("█")

    await ctx.press("\x1b[5~")
    await ctx.press("\x1b[5~")
    screen = await ctx.frame()
    expect(screen).not.toContain("line-59")
    expect(screen).toContain("Message Claude")
  }))

test("Ctrl+G shows the team and marks the orchestrator", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    const screen = await ctx.frame()
    expect(screen).toContain("Team")
    expect(screen).toContain("★ Lead")
    expect(screen).toContain("Codex")
    expect(screen).toContain("Tools")
    expect(screen).toContain("Skills")
    await ctx.escape()
    expect(await ctx.frame()).toContain("Describe a goal")
  }))

test.each([
  ["Ctrl+P, or Ctrl+Shift+P without the Kitty protocol", "\x10"],
  ["Ctrl+Shift+P through the Kitty protocol", "\x1b[112;6u"],
  ["Ctrl+Shift+P through the Kitty protocol, uppercase", "\x1b[80;6u"],
  ["Ctrl+Shift+P through modifyOtherKeys", "\x1b[27;6;112~"],
  ["Ctrl+Shift+P through modifyOtherKeys, uppercase", "\x1b[27;6;80~"],
  ["F2", "\x1bOQ"],
])("%s opens the settings", (_name, sequence) =>
  withApp(async (ctx) => {
    await ctx.send(sequence)
    expect(await ctx.frame()).toContain("Settings")
    await ctx.escape()
    expect(await ctx.frame()).toContain("Describe a goal")
  }))

test("Shift works with terminals that report uppercase names", () =>
  withApp(async (ctx) => {
    await ctx.send("\x1b[27;6;71~")
    expect(await ctx.frame()).toContain("Team")
    await ctx.send("\x1b[27;2;78~")
    expect(await ctx.frame()).toContain("Ctrl+S save")
  }))

test("the settings create an agent", () =>
  withApp(async (ctx) => {
    await ctx.press("p", { ctrl: true })
    await ctx.enter()
    expect(await ctx.frame()).toContain("Ctrl+S save")
  }))

test("the settings open the team and switch the session mode", () =>
  withApp(async (ctx) => {
    await ctx.press("p", { ctrl: true })
    expect(await ctx.frame()).toContain("READ-ONLY")
    await ctx.arrow("up")
    await ctx.enter()
    let screen = await ctx.frame()
    expect(screen).toContain("Settings")
    expect(screen).toContain("EDIT")
    expect(screen).not.toContain("READ-ONLY")

    await ctx.arrow("up")
    await ctx.enter()
    screen = await ctx.frame()
    expect(screen).toContain("★ Lead")
  }))

/** Opens the form for a new agent and leaves the focus on the given field. */
async function newAgent(ctx: Ctx, name: string, tabs = 1) {
  await ctx.press("g", { ctrl: true })
  await ctx.type("n")
  await ctx.press("TAB")
  await ctx.type(name)
  for (let count = 1; count < tabs; count++) await ctx.press("TAB")
}
const MODEL_TABS = 4
const SKILLS_TABS = 5
const TOOLS_TABS = 6
const savedAgents = () => savedFile().agents

test("creates an agent with its name, provider, model, skills and tools", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.type("n")
    expect(await ctx.frame()).toContain("New agent")

    await ctx.press("TAB")
    await ctx.type("Diseño UX")
    await ctx.press("TAB")
    await ctx.type("Designs screens")
    await ctx.press("TAB")
    await ctx.arrow("right")
    await ctx.arrow("right")
    expect(await ctx.frame()).toContain("◂ opencode ▸")
    await ctx.press("TAB")

    let screen = await ctx.frame()
    expect(screen).toContain("CLI default")
    expect(screen).toContain("openai/gpt-5.5")

    await ctx.type("glm")
    screen = await ctx.frame()
    expect(screen).toContain("zai/glm-5")
    expect(screen).not.toContain("openai/gpt-5.5")
    expect(screen).not.toContain("CLI default")
    await ctx.enter()

    // The form moved on to skills.
    screen = await ctx.frame()
    expect(screen).toContain("Search 3 skills")
    expect(screen).toContain("[ ] caveman")
    await ctx.type("clean")
    screen = await ctx.frame()
    expect(screen).toContain("[ ] clean-code")
    expect(screen).not.toContain("caveman")
    await ctx.enter()
    expect(await ctx.frame()).toContain("[x] clean-code")

    await ctx.press("TAB")
    screen = await ctx.frame()
    expect(screen).toContain("Reading the project is always allowed")
    expect(screen).toContain("▸ [ ] Edit files")
    await ctx.press(" ")
    await ctx.arrow("down")
    await ctx.arrow("down")
    await ctx.press(" ")
    screen = await ctx.frame()
    expect(screen).toContain("[x] Edit files")
    expect(screen).toContain("▸ [x] Search the web")

    await ctx.press("s", { ctrl: true })
    expect(savedAgents()).toEqual([
      {
        id: "diseno-ux",
        name: "Diseño UX",
        description: "Designs screens",
        provider: "opencode",
        model: "zai/glm-5",
        instructions: "",
        mode: "edit",
        tools: ["edit", "web"],
        skills: ["clean-code"],
      },
    ])

    screen = await ctx.frame()
    expect(screen).toContain("Team")
    expect(screen).toContain("opencode/zai/glm-5")
    expect(screen).toContain("edit web")
    await ctx.escape()
    expect((await ctx.frame()).split("\n")[0]).toContain("Diseño UX")
  }))

test("a new agent can't change anything until given the tools", () =>
  withApp(async (ctx) => {
    await newAgent(ctx, "Reader")
    await ctx.press("s", { ctrl: true })
    expect(savedAgents()[0]).toMatchObject({ mode: "read-only", tools: [], skills: [] })
  }))

test("running commands alone also counts as being able to change things", () =>
  withApp(async (ctx) => {
    await newAgent(ctx, "Runner", TOOLS_TABS)
    await ctx.arrow("down")
    await ctx.press(" ")
    await ctx.press("s", { ctrl: true })
    expect(savedAgents()[0]).toMatchObject({ mode: "edit", tools: ["shell"] })
  }))

test("a template brings its tools", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.type("n")
    await ctx.arrow("right")
    await ctx.press("s", { ctrl: true })
    expect(savedAgents()[0]).toMatchObject({ name: "Security", tools: ["web"], mode: "read-only" })
  }))

test("shows tools that a CLI can't turn off, and doesn't save them", () =>
  withApp(async (ctx) => {
    await newAgent(ctx, "Codexer", 3)
    await ctx.arrow("right")
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.press("TAB")
    const screen = await ctx.frame()
    expect(screen).toContain("[x] Run commands (always on in codex")
    expect(screen).toContain("[x] MCP servers (always on in codex")
    expect(screen).toContain("▸ [ ] Edit files")
    await ctx.press("s", { ctrl: true })
    expect(savedAgents()[0]).toMatchObject({ provider: "codex", tools: [], mode: "read-only" })
  }))

test("skills are unset until touched, and can be unchecked", () =>
  withApp(async (ctx) => {
    await newAgent(ctx, "Skilled", SKILLS_TABS)
    await ctx.enter()
    await ctx.arrow("down")
    await ctx.enter()
    await ctx.arrow("up")
    await ctx.enter()
    await ctx.press("TAB")
    expect(await ctx.frame()).toContain("clean-code")
    await ctx.press("s", { ctrl: true })
    expect(savedAgents()[0].skills).toEqual(["clean-code"])
  }))

test("keeps a skill that no longer exists visible, so it can be removed", async () => {
  mkdirSync(dirname(paths.global), { recursive: true })
  writeFileSync(
    paths.global,
    JSON.stringify({
      agents: [{ id: "old", name: "Old", description: "", provider: "claude", instructions: "", mode: "read-only", tools: [], skills: ["ghost"] }],
    }),
  )
  await withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.arrow("down")
    await ctx.arrow("down")
    await ctx.arrow("down")
    await ctx.arrow("down")
    await ctx.type("e")
    expect(await ctx.frame()).toContain("Edit Old")
    for (let count = 0; count < 4; count++) await ctx.press("TAB")
    expect(await ctx.frame()).toContain("[x] ghost · not found")
    await ctx.enter()
    await ctx.press("s", { ctrl: true })
    expect(savedAgents()[0].skills).toEqual([])
  })
})

test("the model list moves with the arrows, and accepts a name that isn't listed", () =>
  withApp(async (ctx) => {
    await newAgent(ctx, "Alpha", MODEL_TABS)
    await ctx.arrow("down")
    await ctx.arrow("down")
    expect(await ctx.frame()).toContain("▸ opus")
    await ctx.enter()
    await ctx.press("s", { ctrl: true })
    expect(savedAgents()[0].model).toBe("opus")

    await ctx.type("n")
    await ctx.press("TAB")
    await ctx.type("Beta")
    for (let count = 1; count < MODEL_TABS; count++) await ctx.press("TAB")
    await ctx.type("claude-custom-9")
    expect(await ctx.frame()).toContain('Use "claude-custom-9"')
    await ctx.enter()
    await ctx.press("s", { ctrl: true })
    expect(savedAgents()[1].model).toBe("claude-custom-9")
  }))

test("if the model list fails, says so and still takes a typed name", () =>
  withApp(
    async (ctx) => {
      await newAgent(ctx, "Gamma", MODEL_TABS)
      expect(await ctx.frame()).toContain("Couldn't read the model list")
      await ctx.type("a-model")
      await ctx.press("s", { ctrl: true })
      expect(savedAgents()[0].model).toBe("a-model")
    },
    100,
    async () => {
      throw new Error("no auth")
    },
  ))

test("changing the provider clears a model that belongs to another", () =>
  withApp(async (ctx) => {
    await newAgent(ctx, "Delta", MODEL_TABS)
    await ctx.type("sonnet")
    await ctx.press("TAB", { shift: true })
    await ctx.arrow("right")
    await ctx.press("s", { ctrl: true })
    expect(savedAgents()[0]).not.toHaveProperty("model")
    expect(savedAgents()[0].provider).toBe("codex")
  }))

test("editing a built-in's model keeps its defaults, and deleting the copy restores it", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.arrow("down")
    await ctx.type("e")
    expect(await ctx.frame()).toContain("Edit Claude")
    for (let count = 0; count < 3; count++) await ctx.press("TAB")
    await ctx.type("haiku")
    await ctx.enter()
    await ctx.press("TAB")
    let screen = await ctx.frame()
    expect(screen).toContain("What its CLI finds")
    await ctx.press("s", { ctrl: true })
    expect(savedAgents()[0]).toMatchObject({ id: "claude", model: "haiku", mode: "edit" })
    expect(savedAgents()[0]).not.toHaveProperty("tools")
    expect(savedAgents()[0]).not.toHaveProperty("skills")
    expect(await ctx.frame()).toContain("claude/haiku")

    await ctx.type("e")
    for (let count = 0; count < 3; count++) await ctx.press("TAB")
    screen = await ctx.frame()
    expect(screen).toContain("▸ haiku")
    expect(screen).toContain("fable")
    await ctx.escape()

    await ctx.type("d")
    expect(await ctx.frame()).toContain("Restore Claude")
    await ctx.type("y")
    const restored = await ctx.frame()
    expect(restored).toContain("back to its original version")
    expect(restored).not.toContain("claude/haiku")
    expect(savedAgents()).toEqual([])
  }))

test("a built-in that wasn't changed can't be deleted", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.type("d")
    expect(await ctx.frame()).toContain("is built in")
  }))

test("o makes an agent the orchestrator, which changes the tabs and is remembered", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.arrow("down")
    await ctx.arrow("down")
    await ctx.type("o")
    let screen = await ctx.frame()
    expect(screen).toContain("★ Codex")
    expect(screen).toContain("Codex is now the orchestrator.")
    expect(savedFile().orchestrator).toBe("codex")

    await ctx.escape()
    screen = await ctx.frame()
    expect(screen).toContain("Codex · codex")
    expect(screen.split("\n")[0]).toContain("Lead")
    expect(screen.split("\n")[0]).not.toContain("Codex")

    await ctx.type("hi")
    await ctx.enter()
    expect(ctx.calls[0]?.provider).toBe("codex")
  }))

test("won't delete or edit an agent while it works", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.arrow("down")
    await ctx.type("e")
    await ctx.press("TAB")
    await ctx.press("s", { ctrl: true })
    await ctx.escape()
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.type("hi")
    await ctx.enter()
    expect(ctx.calls.length).toBe(1)

    await ctx.press("g", { ctrl: true })
    await ctx.type("d")
    expect(await ctx.frame()).toContain("is working")
    await ctx.type("e")
    const screen = await ctx.frame()
    expect(screen).toContain("is working")
    expect(screen).not.toContain("Edit Claude")
  }))

test("a file that can't be loaded is reported, and saving doesn't overwrite it", async () => {
  mkdirSync(dirname(paths.global), { recursive: true })
  writeFileSync(paths.global, "{ oops")
  await withApp(async (ctx) => {
    expect(await ctx.frame()).toContain("saving is blocked")
    await newAgent(ctx, "Epsilon")
    await ctx.press("s", { ctrl: true })
    expect(await ctx.frame()).toContain("Couldn't save")
    expect(readFileSync(paths.global, "utf8")).toBe("{ oops")
  }, 140)
})

test("rejects a repeated name in the form", () =>
  withApp(async (ctx) => {
    await newAgent(ctx, "Codex")
    await ctx.press("s", { ctrl: true })
    expect(await ctx.frame()).toContain("already exists")
  }))

test("in a narrow terminal, the panel only shows when asked for", () =>
  withApp(
    async (ctx) => {
      await propose(ctx, [task("a", "codex")])
      let screen = await ctx.frame()
      expect(screen).not.toContain("Tasks")
      expect(screen).toContain("Lead")
      await ctx.press("t", { ctrl: true })
      screen = await ctx.frame()
      expect(screen).toContain("Tasks")
      expect(screen).not.toContain("Lead · claude")
    },
    60,
  ))

test("with many agents, the selected tab stays visible", () =>
  withApp(
    async (ctx) => {
      await ctx.press("TAB", { shift: true })
      const first = (await ctx.frame()).split("\n")[0]
      expect(first).toContain("OpenCode")
      expect(first).not.toContain("Orchestrator")
    },
    30,
  ))

test("a short terminal keeps the selected task, the form list and the prompt on screen", () =>
  withApp(
    async (ctx) => {
      await propose(ctx, Array.from({ length: 8 }, (_, index) => task(`k${index}`, "codex")))
      await ctx.press("t", { ctrl: true })
      for (let step = 0; step < 7; step++) await ctx.arrow("down")
      const screen = await ctx.frame()
      expect(screen).toContain("▸○  8 Task k7")
      expect(screen).toContain("Describe a goal")
    },
    100,
    defaultModels,
    14,
  ))
