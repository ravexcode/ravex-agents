import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { AgentStore, type AgentPaths } from "./agents/store.ts"
import { App } from "./app.tsx"
import { Team } from "./core/team.ts"
import type { ListModels } from "./providers/models.ts"
import type { RunTurn, TurnResult } from "./providers/runner.ts"
import type { Provider, ProviderEvent, ProviderId, TurnRequest } from "./providers/types.ts"

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
const providers = [fake("claude", "Claude"), fake("codex", "Codex"), fake("opencode", "OpenCode")]

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
        providerIds={providers.map((provider) => provider.id)}
        listModels={listModels}
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

const plan = (tasks: object[]) => `Reparto el trabajo.\n\`\`\`ravex-plan\n${JSON.stringify({ tasks })}\n\`\`\``
const task = (key: string, agent: string, overrides: object = {}) => ({
  key,
  title: `Tarea ${key}`,
  description: `do ${key}`,
  agent,
  ...overrides,
})

async function propose(ctx: Ctx, tasks: object[]) {
  await ctx.type("Añade rate limit")
  await ctx.enter()
  await ctx.reply(ctx.calls.at(-1) as Call, plan(tasks))
}

test("opens on the orchestrator's chat, with the tasks beside it", () =>
  withApp(async ({ frame }) => {
    const screen = await frame()
    expect(screen).toContain("ORQUESTADOR")
    expect(screen).toContain("Sala")
    expect(screen).toContain("SOLO LECTURA")
    expect(screen).toContain("Lead · claude")
    expect(screen).toContain("Tareas")
    expect(screen).toContain("Sin tareas todavía")
    expect(screen).toContain("Al orquestador")
    // The orchestrator is its own tab, not also an agent.
    expect(screen.split("\n")[0]).not.toContain("Lead")
  }))

test("a goal becomes a proposal, and nothing runs until Enter approves it", () =>
  withApp(async (ctx) => {
    await ctx.type("Añade rate limit")
    await ctx.enter()
    expect(ctx.calls.length).toBe(1)
    expect(ctx.calls[0]?.request.prompt).toBe("Añade rate limit")
    expect(await ctx.frame()).toContain("> Añade rate limit")

    await ctx.reply(ctx.calls[0] as Call, plan([task("a", "codex"), task("b", "opencode", { dependsOn: ["a"], edits: true })]))
    let screen = await ctx.frame()
    expect(screen).toContain("Reparto el trabajo.")
    expect(screen).not.toContain("ravex-plan")
    expect(screen).toContain("○  1 Tarea a")
    expect(screen).toContain("○  2 Tarea b")
    expect(screen).toContain("← espera a 1")
    expect(screen).toContain("Enter aprueba")
    expect(screen).toContain("Aprobar no da permisos")
    expect(ctx.calls.length).toBe(1)

    await ctx.enter()
    screen = await ctx.frame()
    expect(ctx.calls.length).toBe(2)
    expect(ctx.calls[1]?.provider).toBe("codex")
    expect(screen).toContain("●  1 Tarea a")
    expect(screen).toContain("Aprobar no da permisos")
  }))

test("Esc discards a proposal, and an empty Enter does nothing without one", () =>
  withApp(async (ctx) => {
    await ctx.enter()
    expect(ctx.calls.length).toBe(0)

    await propose(ctx, [task("a", "codex")])
    await ctx.escape()
    const screen = await ctx.frame()
    expect(screen).toContain("Plan descartado.")
    expect(screen).toContain("Sin tareas todavía")
    await ctx.enter()
    expect(ctx.calls.length).toBe(1)
  }))

test("typing on a proposal asks for a new plan", () =>
  withApp(async (ctx) => {
    await propose(ctx, [task("a", "codex")])
    await ctx.type("hazlo con opencode")
    await ctx.enter()
    expect(ctx.calls.length).toBe(2)
    expect(ctx.calls[1]?.request.prompt).toContain("hazlo con opencode")
    expect(ctx.calls[1]?.request.mode).toBe("read-only")
  }))

test("the input clears, even when Enter comes right after typing", () =>
  withApp(async (ctx) => {
    await ctx.press("TAB")
    await ctx.type("hola sala")
    await ctx.enter()
    await ctx.type("otra")
    await ctx.enter()
    const screen = await ctx.frame()
    expect(screen).toContain("> hola sala")
    expect(screen).toContain("> otra")
    expect(screen).not.toContain("hola salaotra")
  }))

test("the task panel moves, reassigns and opens a task", () =>
  withApp(async (ctx) => {
    await propose(ctx, [task("a", "codex", { edits: true }), task("b", "opencode")])

    await ctx.press("t", { ctrl: true })
    let screen = await ctx.frame()
    expect(screen).toContain("▸○  1 Tarea a")
    expect(screen).toContain("r reasignar")

    await ctx.arrow("down")
    screen = await ctx.frame()
    expect(screen).toContain("▸○  2 Tarea b")

    // Keys here belong to the panel, not to the input.
    await ctx.type("r")
    expect(ctx.team.getState().board.tasks[1]?.assignee).toBe("claude")
    expect(await ctx.frame()).not.toContain("> r")

    await ctx.arrow("up")
    await ctx.enter()
    screen = await ctx.frame()
    expect(screen).toContain("Tarea 1 · propuesta")
    expect(screen).toContain("do a")
    expect(screen).toContain("Asignada a Codex · edita archivos")
    expect(ctx.calls.length).toBe(1)

    await ctx.type("mira los tests")
    await ctx.enter()
    screen = await ctx.frame()
    expect(screen).toContain("Tú: mira los tests")
    expect(ctx.team.getState().board.tasks[0]?.comments).toEqual([{ author: "you", text: "mira los tests" }])

    await ctx.escape()
    screen = await ctx.frame()
    expect(screen).toContain("Tarea a")
    expect(screen).toContain("r reasignar")
    await ctx.escape()
    expect(await ctx.frame()).toContain("Enter aprueba")
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
    await ctx.reply(work, "Encontré dos fallos")

    await ctx.press("t", { ctrl: true })
    await ctx.enter()
    const screen = await ctx.frame()
    expect(screen).toContain("Tarea 1 · hecha")
    expect(screen).toContain("Resultado")
    expect(screen).toContain("Encontré dos fallos")
    expect(screen).toContain("Conversación del agente")
    expect(screen).toContain("read: src/x.ts")
  }))

test("Tab goes through the orchestrator, the room and each agent", () =>
  withApp(async (ctx) => {
    await ctx.press("TAB")
    let screen = await ctx.frame()
    expect(screen.split("\n")[0]).toContain("SALA")
    expect(screen).toContain("A la sala")

    await ctx.press("TAB")
    screen = await ctx.frame()
    expect(screen.split("\n")[0]).toContain("CLAUDE")
    expect(screen).toContain("A Claude")

    await ctx.press("TAB", { shift: true })
    await ctx.press("TAB", { shift: true })
    expect((await ctx.frame()).split("\n")[0]).toContain("ORQUESTADOR")

    await ctx.press("TAB", { shift: true })
    expect((await ctx.frame()).split("\n")[0]).toContain("OPENCODE")
  }))

test("in the room, only a mention spends anything", () =>
  withApp(async (ctx) => {
    await ctx.press("TAB")
    await ctx.type("hola")
    await ctx.enter()
    let screen = await ctx.frame()
    expect(screen).toContain("Nadie responde sin una mención")
    expect(ctx.calls.length).toBe(0)

    await ctx.type("@codex qué opinas")
    await ctx.enter()
    expect(ctx.calls.length).toBe(1)
    expect(ctx.calls[0]?.request.mode).toBe("read-only")
    expect(await ctx.frame()).toContain("Codex está respondiendo…")

    await ctx.reply(ctx.calls[0] as Call, "Me parece bien")
    screen = await ctx.frame()
    expect(screen).toContain("Codex: Me parece bien")
    expect(screen).not.toContain("está respondiendo")
  }))

test("a room turn of the orchestrator stays out of its chat", () =>
  withApp(async (ctx) => {
    await ctx.press("TAB")
    await ctx.type("@lead qué tal")
    await ctx.enter()
    await ctx.reply(ctx.calls[0] as Call, "Todo bien")
    expect(await ctx.frame()).toContain("Lead: Todo bien")
    await ctx.press("TAB", { shift: true })
    const screen = await ctx.frame()
    expect(screen).not.toContain("Todo bien")
    expect(screen).not.toContain("Mención en la sala")
  }))

test("a direct message goes to that agent, and Esc cancels it", () =>
  withApp(async (ctx) => {
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.type("hola claude")
    await ctx.enter()
    expect(ctx.calls[0]?.request.prompt).toBe("hola claude")
    expect((await ctx.frame()).split("\n")[0]).toContain("● CLAUDE")
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
    expect(screen).toContain("Trabajo detenido")
    expect(screen).toContain("–  1 Tarea a")

    await ctx.escape()
    screen = await ctx.frame()
    expect(screen).toContain("Pulsa Esc otra vez")
    expect(ctx.team.getState().board.phase).toBe("paused")

    await ctx.escape()
    expect(ctx.team.getState().board.phase).toBe("idle")
    screen = await ctx.frame()
    expect(screen).toContain("–  2 Tarea b")
    expect(screen).not.toContain("Pulsa Esc otra vez")
  }))

test("Ctrl+E changes the session's mode", () =>
  withApp(async (ctx) => {
    await ctx.press("e", { ctrl: true })
    expect(await ctx.frame()).toContain("EDICIÓN")
    await ctx.press("e", { ctrl: true })
    expect(await ctx.frame()).toContain("SOLO LECTURA")
  }))

test("Ctrl+G shows the team and marks the orchestrator", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    const screen = await ctx.frame()
    expect(screen).toContain("Equipo")
    expect(screen).toContain("★ Lead")
    expect(screen).toContain("Codex")
    expect(screen).toContain("opencode")
    await ctx.escape()
    expect(await ctx.frame()).toContain("Al orquestador")
  }))

test("creates an agent choosing a provider and a model from the list", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.type("n")
    expect(await ctx.frame()).toContain("Nuevo agente")

    await ctx.press("TAB")
    await ctx.type("Diseño UX")
    await ctx.press("TAB")
    await ctx.type("Diseña pantallas")
    await ctx.press("TAB")
    await ctx.arrow("right")
    expect(await ctx.frame()).toContain("◂ codex ▸")
    await ctx.press("TAB")

    let screen = await ctx.frame()
    expect(screen).toContain("Por defecto de la CLI")
    expect(screen).toContain("openai/gpt-5.5")

    await ctx.type("glm")
    screen = await ctx.frame()
    expect(screen).toContain("zai/glm-5")
    expect(screen).not.toContain("openai/gpt-5.5")
    expect(screen).not.toContain("Por defecto de la CLI")

    await ctx.enter()
    await ctx.press("s", { ctrl: true })
    expect(savedFile().agents).toEqual([
      {
        id: "diseno-ux",
        name: "Diseño UX",
        description: "Diseña pantallas",
        provider: "codex",
        model: "zai/glm-5",
        instructions: "",
        mode: "read-only",
      },
    ])

    screen = await ctx.frame()
    expect(screen).toContain("Equipo")
    expect(screen).toContain("codex/zai/glm-5")
    await ctx.escape()
    expect((await ctx.frame()).split("\n")[0]).toContain("Diseño UX")
  }))

test("the model list moves with the arrows, and accepts a name that isn't listed", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.type("n")
    await ctx.press("TAB")
    await ctx.type("Alpha")
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.press("TAB")

    await ctx.arrow("down")
    await ctx.arrow("down")
    expect(await ctx.frame()).toContain("▸ opus")
    await ctx.enter()
    await ctx.press("s", { ctrl: true })
    expect(savedFile().agents[0].model).toBe("opus")

    await ctx.type("n")
    await ctx.press("TAB")
    await ctx.type("Beta")
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.type("claude-custom-9")
    expect(await ctx.frame()).toContain('Usar "claude-custom-9"')
    await ctx.enter()
    await ctx.press("s", { ctrl: true })
    expect(savedFile().agents[1].model).toBe("claude-custom-9")
  }))

test("if the model list fails, says so and still takes a typed name", () =>
  withApp(
    async (ctx) => {
      await ctx.press("g", { ctrl: true })
      await ctx.type("n")
      await ctx.press("TAB")
      await ctx.type("Gamma")
      await ctx.press("TAB")
      await ctx.press("TAB")
      await ctx.press("TAB")
      expect(await ctx.frame()).toContain("No se pudo leer la lista de modelos")
      await ctx.type("a-model")
      await ctx.press("s", { ctrl: true })
      expect(savedFile().agents[0].model).toBe("a-model")
    },
    100,
    async () => {
      throw new Error("no auth")
    },
  ))

test("changing the provider clears a model that belongs to another", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.type("n")
    await ctx.press("TAB")
    await ctx.type("Delta")
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.type("sonnet")
    await ctx.press("TAB", { shift: true })
    await ctx.arrow("right")
    await ctx.press("s", { ctrl: true })
    expect(savedFile().agents[0]).not.toHaveProperty("model")
    expect(savedFile().agents[0].provider).toBe("codex")
  }))

test("the list opens on the current model when editing, and a built-in can be changed and restored", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.arrow("down")
    await ctx.type("e")
    expect(await ctx.frame()).toContain("Editar Claude")
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.type("haiku")
    await ctx.enter()
    await ctx.press("s", { ctrl: true })
    expect(savedFile().agents[0]).toMatchObject({ id: "claude", model: "haiku" })
    expect(await ctx.frame()).toContain("claude/haiku")

    await ctx.type("e")
    await ctx.press("TAB")
    await ctx.press("TAB")
    await ctx.press("TAB")
    const screen = await ctx.frame()
    expect(screen).toContain("▸ haiku")
    expect(screen).toContain("fable")
    await ctx.escape()

    await ctx.type("d")
    expect(await ctx.frame()).toContain("¿Restaurar Claude")
    await ctx.type("y")
    const restored = await ctx.frame()
    expect(restored).toContain("ha vuelto a su versión original")
    expect(restored).not.toContain("claude/haiku")
    expect(savedFile().agents).toEqual([])
  }))

test("a built-in that wasn't changed can't be deleted", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.type("d")
    expect(await ctx.frame()).toContain("es un agente base")
  }))

test("o makes an agent the orchestrator, which changes the tabs and is remembered", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.arrow("down")
    await ctx.arrow("down")
    await ctx.type("o")
    let screen = await ctx.frame()
    expect(screen).toContain("★ Codex")
    expect(screen).toContain("Codex es ahora el orquestador.")
    expect(savedFile().orchestrator).toBe("codex")

    await ctx.escape()
    screen = await ctx.frame()
    expect(screen).toContain("Codex · codex")
    expect(screen.split("\n")[0]).toContain("Lead")
    expect(screen.split("\n")[0]).not.toContain("Codex")

    await ctx.type("hola")
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
    await ctx.type("hola")
    await ctx.enter()
    expect(ctx.calls.length).toBe(1)

    await ctx.press("g", { ctrl: true })
    await ctx.type("d")
    expect(await ctx.frame()).toContain("está trabajando")
    await ctx.type("e")
    const screen = await ctx.frame()
    expect(screen).toContain("está trabajando")
    expect(screen).not.toContain("Editar Claude")
  }))

test("a file that can't be loaded is reported, and saving doesn't overwrite it", async () => {
  mkdirSync(dirname(paths.global), { recursive: true })
  writeFileSync(paths.global, "{ oops")
  await withApp(async (ctx) => {
    expect(await ctx.frame()).toContain("guardar está bloqueado")
    await ctx.press("g", { ctrl: true })
    await ctx.type("n")
    await ctx.press("TAB")
    await ctx.type("Epsilon")
    await ctx.press("s", { ctrl: true })
    expect(await ctx.frame()).toContain("No se pudo guardar")
    expect(readFileSync(paths.global, "utf8")).toBe("{ oops")
  }, 140)
})

test("rejects a repeated name in the form", () =>
  withApp(async (ctx) => {
    await ctx.press("g", { ctrl: true })
    await ctx.type("n")
    await ctx.press("TAB")
    await ctx.type("Codex")
    await ctx.press("s", { ctrl: true })
    expect(await ctx.frame()).toContain("Ya existe un agente")
  }))

test("in a narrow terminal, the panel only shows when asked for", () =>
  withApp(
    async (ctx) => {
      let screen = await ctx.frame()
      expect(screen).not.toContain("Tareas")
      expect(screen).toContain("Lead")
      await ctx.press("t", { ctrl: true })
      screen = await ctx.frame()
      expect(screen).toContain("Tareas")
      expect(screen).not.toContain("Lead · claude")
    },
    60,
  ))

test("with many agents, the selected tab stays visible", () =>
  withApp(
    async (ctx) => {
      await ctx.press("TAB", { shift: true })
      expect((await ctx.frame()).split("\n")[0]).toContain("OPENCODE")
    },
    30,
  ))

test("a short terminal keeps the selected task and the input on screen", () =>
  withApp(
    async (ctx) => {
      await propose(ctx, Array.from({ length: 8 }, (_, index) => task(`k${index}`, "codex")))
      await ctx.press("t", { ctrl: true })
      for (let step = 0; step < 7; step++) await ctx.arrow("down")
      const screen = await ctx.frame()
      expect(screen).toContain("▸○  8 Tarea k7")
      expect(screen).toContain("Al orquestador")
    },
    100,
    defaultModels,
    14,
  ))
