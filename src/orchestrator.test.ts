import { expect, test } from "bun:test"
import { Orchestrator } from "./orchestrator.ts"
import type { RunTurn, TurnResult } from "./providers/runner.ts"
import type { Provider, ProviderEvent, ProviderId, TurnRequest } from "./providers/types.ts"

const fake = (id: ProviderId): Provider => ({
  id,
  label: id,
  binary: id,
  buildArgs: () => [],
  parseLine: () => [],
})

interface Call {
  id: ProviderId
  request: TurnRequest
  signal: AbortSignal
  emit: (event: ProviderEvent) => void
  finish: (result: TurnResult) => void
}

function setup(isAvailable: (provider: Provider) => boolean = () => true) {
  const calls: Call[] = []
  const run: RunTurn = (provider, request, onEvent, signal) =>
    new Promise((resolve) => {
      calls.push({ id: provider.id, request, signal, emit: onEvent, finish: resolve })
    })
  const orchestrator = new Orchestrator([fake("claude"), fake("codex"), fake("opencode")], {
    cwd: "/project",
    run,
    isAvailable,
  })
  const pane = (id: ProviderId) => orchestrator.getState().panes.find((p) => p.id === id)!
  const texts = (id: ProviderId) => pane(id).entries.map((e) => `${e.kind}:${e.text}`)
  return { calls, orchestrator, pane, texts }
}

const settle = () => Bun.sleep(0)

test("sends to every provider at once, or to just one", () => {
  const { calls, orchestrator } = setup()
  orchestrator.send("all", " hi ")
  expect(calls.map((c) => c.id)).toEqual(["claude", "codex", "opencode"])
  expect(calls[0]?.request).toEqual({
    prompt: "hi",
    cwd: "/project",
    mode: "read-only",
    sessionId: undefined,
  })

  const single = setup()
  single.orchestrator.send("codex", "hi")
  expect(single.calls.map((c) => c.id)).toEqual(["codex"])
})

test("ignores blank prompts", () => {
  const { calls, orchestrator } = setup()
  orchestrator.send("all", "   ")
  expect(calls).toEqual([])
})

test("keeps each provider's output separate and appends deltas", async () => {
  const { calls, orchestrator, texts, pane } = setup()
  orchestrator.send("all", "hi")
  const [claude, codex] = calls

  claude?.emit({ type: "text-delta", text: "Hel" })
  codex?.emit({ type: "text-delta", text: "other" })
  claude?.emit({ type: "text-delta", text: "lo" })
  claude?.emit({ type: "tool", name: "Read", detail: "a.ts" })
  claude?.emit({ type: "text-delta", text: "after" })
  claude?.emit({ type: "text-start" })
  claude?.emit({ type: "text-delta", text: "block" })

  expect(texts("claude")).toEqual([
    "user:hi",
    "assistant:Hello",
    "tool:Read: a.ts",
    "assistant:after",
    "assistant:block",
  ])
  expect(texts("codex")).toEqual(["user:hi", "assistant:other"])
  expect(pane("claude").status).toBe("running")

  claude?.finish({ status: "done" })
  await settle()
  expect(pane("claude").status).toBe("done")
  expect(pane("codex").status).toBe("running")
})

test("resumes a session only after a successful turn", async () => {
  const { calls, orchestrator } = setup()

  orchestrator.send("codex", "first")
  calls[0]?.emit({ type: "session", sessionId: "broken" })
  calls[0]?.finish({ status: "failed" })
  await settle()

  orchestrator.send("codex", "second")
  expect(calls[1]?.request.sessionId).toBeUndefined()
  calls[1]?.emit({ type: "session", sessionId: "good" })
  calls[1]?.finish({ status: "done" })
  await settle()

  orchestrator.send("codex", "third")
  expect(calls[2]?.request.sessionId).toBe("good")
  calls[2]?.emit({ type: "session", sessionId: "next" })
  calls[2]?.finish({ status: "failed" })
  await settle()

  orchestrator.send("codex", "fourth")
  expect(calls[3]?.request.sessionId).toBe("good")
})

test("doesn't start a second turn while one is running", () => {
  const { calls, orchestrator, texts } = setup()
  orchestrator.send("claude", "one")
  orchestrator.send("claude", "two")
  expect(calls).toHaveLength(1)
  expect(texts("claude").at(-1)).toStartWith("info:")
})

test("reports a provider that isn't installed without affecting the others", () => {
  const { calls, orchestrator, texts, pane } = setup((provider) => provider.id !== "codex")
  orchestrator.send("all", "hi")
  expect(calls.map((c) => c.id)).toEqual(["claude", "opencode"])
  expect(pane("codex").available).toBe(false)
  expect(texts("codex")).toEqual(["error:codex was not found in PATH"])
})

test("a failure in one provider leaves the others running", async () => {
  const { calls, orchestrator, pane, texts } = setup()
  orchestrator.send("all", "hi")
  calls[1]?.emit({ type: "error", fatal: false, message: "revoked" })
  calls[1]?.emit({ type: "error", fatal: true, message: "revoked" })
  calls[1]?.finish({ status: "failed" })
  await settle()

  expect(pane("codex").status).toBe("failed")
  expect(texts("codex")).toEqual(["user:hi", "error:revoked"])
  expect(pane("claude").status).toBe("running")
})

test("cancel aborts only the targeted provider", async () => {
  const { calls, orchestrator } = setup()
  orchestrator.send("all", "hi")
  orchestrator.cancel("claude")
  expect(calls.map((c) => c.signal.aborted)).toEqual([true, false, false])
  orchestrator.cancel("all")
  expect(calls.map((c) => c.signal.aborted)).toEqual([true, true, true])
})

test("passes the current mode to new turns", () => {
  const { calls, orchestrator } = setup()
  orchestrator.toggleMode()
  orchestrator.send("claude", "hi")
  expect(calls[0]?.request.mode).toBe("edit")
})

test("a rejected run is reported as a failure", async () => {
  const orchestrator = new Orchestrator([fake("claude")], {
    run: () => Promise.reject(new Error("kaboom")),
    isAvailable: () => true,
  })
  orchestrator.send("claude", "hi")
  await settle()
  const pane = orchestrator.getState().panes[0]
  expect(pane?.status).toBe("failed")
  expect(pane?.entries.at(-1)?.text).toContain("kaboom")
})
