import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
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

async function withApp(
  body: (app: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  width = 120,
): Promise<void> {
  const app = await setup(width)
  try {
    await body(app)
  } finally {
    await act(async () => {
      app.view.renderer.destroy()
    })
  }
}

async function setup(width: number) {
  const prompts: { id: ProviderId; prompt: string; mode: string }[] = []
  const signals: AbortSignal[] = []
  const run: RunTurn = (provider, request, onEvent, signal) => {
    prompts.push({ id: provider.id, prompt: request.prompt, mode: request.mode })
    signals.push(signal)
    onEvent({ type: "text-delta", text: `reply from ${provider.label}` })
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ status: "cancelled" }))
    })
  }
  const orchestrator = new Orchestrator(
    [fake("claude", "Claude"), fake("codex", "Codex"), fake("opencode", "OpenCode")],
    { run, isAvailable: (provider) => provider.id !== "opencode" },
  )

  let view!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    view = await testRender(<App orchestrator={orchestrator} />, { width, height: 24 })
  })

  const frame = async () => {
    await act(async () => {
      await view.renderOnce()
    })
    return view.captureCharFrame()
  }
  const press = (
    key: Parameters<typeof view.mockInput.pressKey>[0],
    modifiers?: { ctrl?: boolean },
    settleMs = SETTLE_MS,
  ) =>
    act(async () => {
      view.mockInput.pressKey(key, modifiers)
      await Bun.sleep(settleMs)
    })
  const submit = (text: string) =>
    act(async () => {
      await view.mockInput.typeText(text)
      view.mockInput.pressEnter()
      await Bun.sleep(SETTLE_MS)
    })

  return { view, prompts, signals, frame, press, submit }
}

test("shows a pane per provider, and flags one that isn't installed", () =>
  withApp(async ({ frame }) => {
    const screen = await frame()
    expect(screen).toContain("Claude · idle")
    expect(screen).toContain("Codex · idle")
    expect(screen).toContain("OpenCode · not installed")
    expect(screen).toContain("To: All")
    expect(screen).toContain("READ-ONLY")
  }))

test("sends a prompt to all providers and shows each reply in its pane", () =>
  withApp(async ({ prompts, frame, submit }) => {
    await submit("hello")
    expect(prompts.map((p) => p.id)).toEqual(["claude", "codex"])
    const screen = await frame()
    expect(screen).toContain("reply from Claude")
    expect(screen).toContain("reply from Codex")
    expect(screen).toContain("Claude · running")
    expect(screen).toContain("not found in PATH")
  }))

test("Tab chooses the target, and typing q doesn't quit", () =>
  withApp(async ({ view, prompts, frame, press, submit }) => {
    await press("TAB")
    await press("TAB")
    expect(await frame()).toContain("To: Codex")
    await submit("q")
    expect(view.renderer.isDestroyed).toBe(false)
    expect(prompts).toEqual([{ id: "codex", prompt: "q", mode: "read-only" }])
  }))

test("clears the input after sending, even when Enter follows typing immediately", () =>
  withApp(async ({ view, prompts, frame }) => {
    await act(async () => {
      await view.mockInput.typeText("first")
      view.mockInput.pressEnter()
      await view.mockInput.typeText("second")
      view.mockInput.pressEnter()
      await Bun.sleep(SETTLE_MS)
    })
    // Claude and Codex are still running, so only "first" starts a turn.
    expect(prompts.map((p) => p.prompt)).toEqual(["first", "first"])
    expect(await frame()).toContain("Still running")
    await act(async () => {
      await view.mockInput.typeText("third")
      await Bun.sleep(SETTLE_MS)
    })
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

test("stacks the panes on narrow terminals", () =>
  withApp(async ({ frame }) => {
    const lines = (await frame()).split("\n")
    const row = (label: string) => lines.findIndex((line) => line.includes(label))
    expect(row("Claude ·")).toBeLessThan(row("Codex ·"))
    expect(row("Codex ·")).toBeLessThan(row("OpenCode ·"))
  }, 60))
