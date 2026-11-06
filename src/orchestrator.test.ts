import { describe, expect, test } from "bun:test"
import type { Agent } from "./agents/types.ts"
import { ALL_AGENTS, Orchestrator } from "./orchestrator.ts"
import type { RunTurn, TurnResult } from "./providers/runner.ts"
import type { Provider, ProviderEvent, ProviderId, TurnRequest } from "./providers/types.ts"

const provider = (id: ProviderId): Provider => ({
  id,
  label: id,
  binary: id,
  buildArgs: () => [],
  parseLine: () => [],
})
const providers = [provider("claude"), provider("codex"), provider("opencode")]

const agent = (id: string, overrides: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  description: "",
  provider: "claude",
  instructions: "",
  mode: "edit",
  subagents: [],
  origin: "global",
  ...overrides,
})

interface Call {
  agentPrompt: string
  provider: ProviderId
  request: TurnRequest
  signal: AbortSignal
  emit: (event: ProviderEvent) => void
  finish: (result: TurnResult) => void
  reply: (text: string, sessionId?: string) => void
}

function setup(agents: Agent[], isAvailable: (provider: Provider) => boolean = () => true) {
  const calls: Call[] = []
  const run: RunTurn = (runProvider, request, onEvent, signal) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true })
      calls.push({
        agentPrompt: request.prompt,
        provider: runProvider.id,
        request,
        signal,
        emit: onEvent,
        finish: resolve,
        reply: (text, sessionId) => {
          if (sessionId) onEvent({ type: "session", sessionId })
          onEvent({ type: "text-delta", text })
          resolve({ status: "done" })
        },
      })
    })
  const orchestrator = new Orchestrator(providers, agents, { cwd: "/project", run, isAvailable })
  const pane = (id: string) => orchestrator.getState().panes.find((p) => p.id === id)!
  const texts = (id: string) => pane(id).entries.map((e) => `${e.kind}:${e.text}`)
  const call = (prompt: string) => calls.find((c) => c.agentPrompt === prompt)!
  return { calls, orchestrator, pane, texts, call }
}

// Long enough for queued promise callbacks across a chain to run.
const settle = () => Bun.sleep(5)
const delegate = (...tasks: { agent: string; task: string }[]) =>
  "```ravex-delegate\n" + JSON.stringify({ tasks }) + "\n```"

describe("sending", () => {
  test("sends to one agent, using its provider, model and instructions", async () => {
    const { calls, orchestrator } = setup([
      agent("sec", { provider: "codex", model: "m1", instructions: "Audit" }),
      agent("other"),
    ])
    orchestrator.toggleMode()
    orchestrator.send("sec", " hi ")
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.provider).toBe("codex")
    expect(calls[0]?.request).toEqual({
      prompt: "hi",
      cwd: "/project",
      mode: "edit",
      sessionId: undefined,
      model: "m1",
      instructions: "Audit",
    })
  })

  test("two agents on the same provider have separate conversations", async () => {
    const { calls, orchestrator, texts } = setup([agent("a"), agent("b")])
    orchestrator.send(ALL_AGENTS, "hi")
    await settle()
    calls[0]?.emit({ type: "text-delta", text: "from a" })
    calls[1]?.emit({ type: "text-delta", text: "from b" })
    expect(texts("a")).toEqual(["user:hi", "assistant:from a"])
    expect(texts("b")).toEqual(["user:hi", "assistant:from b"])
  })

  test("sending to all reaches root agents but not assigned subagents", async () => {
    const { calls, orchestrator } = setup([agent("lead", { subagents: ["sec"] }), agent("sec"), agent("solo")])
    orchestrator.send(ALL_AGENTS, "hi")
    await settle()
    expect(calls).toHaveLength(2)
  })

  test("a subagent can still be messaged directly", async () => {
    const { calls, orchestrator } = setup([agent("lead", { subagents: ["sec"] }), agent("sec")])
    orchestrator.send("sec", "hi")
    await settle()
    expect(calls).toHaveLength(1)
  })

  test("ignores blank prompts and unknown agents", async () => {
    const { calls, orchestrator } = setup([agent("a")])
    orchestrator.send(ALL_AGENTS, "   ")
    orchestrator.send("missing", "hi")
    await settle()
    expect(calls).toEqual([])
  })

  test("appends deltas and separates text blocks, even if a task is queued mid-stream", async () => {
    const { calls, orchestrator, texts, pane } = setup([
      agent("lead", { subagents: ["sec"] }),
      agent("sec"),
    ])
    orchestrator.send("sec", "direct")
    orchestrator.send("lead", "go")
    await settle()
    const sec = calls[0]!
    const lead = calls[1]!
    sec.emit({ type: "text-delta", text: "Hel" })

    lead.reply(delegate({ agent: "sec", task: "queued" }))
    await settle()
    sec.emit({ type: "text-delta", text: "lo" })
    sec.emit({ type: "tool", name: "Read", detail: "a.ts" })
    sec.emit({ type: "text-delta", text: "after" })
    sec.emit({ type: "text-start" })
    sec.emit({ type: "text-delta", text: "block" })

    expect(texts("sec")).toEqual([
      "user:direct",
      "assistant:Hello",
      "user:[lead] queued",
      "tool:Read: a.ts",
      "assistant:after",
      "assistant:block",
    ])
    expect(pane("sec").status).toBe("running")
  })

  test("doesn't start a second direct turn while one is running", async () => {
    const { calls, orchestrator, texts } = setup([agent("a")])
    orchestrator.send("a", "one")
    orchestrator.send("a", "two")
    await settle()
    expect(calls).toHaveLength(1)
    expect(texts("a").at(-1)).toStartWith("info:")
  })

  test("reports a missing CLI without affecting other agents", async () => {
    const { calls, orchestrator, texts, pane } = setup(
      [agent("a", { provider: "codex" }), agent("b")],
      (p) => p.id !== "codex",
    )
    orchestrator.send(ALL_AGENTS, "hi")
    await settle()
    expect(calls.map((c) => c.provider)).toEqual(["claude"])
    expect(pane("a").available).toBe(false)
    expect(texts("a").at(-1)).toBe("error:codex was not found in PATH")
  })

  test("a rejected run is reported as a failure", async () => {
    const orchestrator = new Orchestrator(providers, [agent("a")], {
      run: () => Promise.reject(new Error("kaboom")),
      isAvailable: () => true,
    })
    orchestrator.send("a", "hi")
    await settle()
    const pane = orchestrator.getState().panes[0]
    expect(pane?.status).toBe("failed")
    expect(pane?.entries.at(-1)?.text).toContain("kaboom")
  })
})

describe("sessions", () => {
  test("resumes a direct conversation only after a successful turn", async () => {
    const { calls, orchestrator } = setup([agent("a")])

    orchestrator.send("a", "first")
    await settle()
    calls[0]?.emit({ type: "session", sessionId: "broken" })
    calls[0]?.finish({ status: "failed" })
    await settle()

    orchestrator.send("a", "second")
    await settle()
    expect(calls[1]?.request.sessionId).toBeUndefined()
    calls[1]?.reply("ok", "good")
    await settle()

    orchestrator.send("a", "third")
    await settle()
    expect(calls[2]?.request.sessionId).toBe("good")
    calls[2]?.emit({ type: "session", sessionId: "next" })
    calls[2]?.finish({ status: "failed" })
    await settle()

    orchestrator.send("a", "fourth")
    await settle()
    expect(calls[3]?.request.sessionId).toBe("good")
  })

  test("delegated tasks start clean and don't touch the direct conversation", async () => {
    const { calls, call, orchestrator } = setup([agent("lead", { subagents: ["sec"] }), agent("sec")])

    orchestrator.send("sec", "direct")
    await settle()
    calls[0]?.reply("ok", "direct-session")
    await settle()

    orchestrator.send("lead", "go")
    await settle()
    call("go").reply(delegate({ agent: "sec", task: "task" }), "lead-session")
    await settle()
    expect(call("task").request.sessionId).toBeUndefined()
    call("task").reply("found", "child-session")
    await settle()

    orchestrator.send("sec", "direct again")
    await settle()
    expect(call("direct again").request.sessionId).toBe("direct-session")
  })

  test("editing an agent starts a new conversation, but other changes don't", async () => {
    const original = agent("a", { instructions: "old" })
    const { calls, orchestrator, texts } = setup([original])
    orchestrator.send("a", "one")
    await settle()
    calls[0]?.reply("ok", "s1")
    await settle()

    orchestrator.setAgents([{ ...original, description: "only a description" }])
    orchestrator.send("a", "two")
    await settle()
    expect(calls[1]?.request.sessionId).toBe("s1")
    calls[1]?.reply("ok", "s1")
    await settle()

    orchestrator.setAgents([{ ...original, instructions: "new" }])
    expect(texts("a").at(-1)).toContain("new conversation")
    orchestrator.send("a", "three")
    await settle()
    expect(calls[2]?.request.sessionId).toBeUndefined()
    expect(calls[2]?.request.instructions).toBe("new")
  })

  test("removing an agent drops its pane and keeps the others", () => {
    const { orchestrator } = setup([agent("a"), agent("b")])
    orchestrator.setAgents([agent("b")])
    expect(orchestrator.getState().panes.map((p) => p.id)).toEqual(["b"])
  })
})

describe("delegation", () => {
  const team = () => [
    agent("lead", { subagents: ["sec", "design"], instructions: "Lead" }),
    agent("sec", { provider: "codex", description: "Security", instructions: "Audit" }),
    agent("design", { provider: "opencode", description: "Design" }),
  ]

  test("tells only parents about their subagents", async () => {
    const { call, orchestrator } = setup(team())
    orchestrator.send("lead", "go")
    await settle()
    expect(call("go").request.instructions).toContain("- sec: Security")
    expect(call("go").request.instructions).toContain("ravex-delegate")

    call("go").reply(delegate({ agent: "sec", task: "audit" }))
    await settle()
    expect(call("audit").request.instructions).toBe("Audit")
  })

  test("runs subagents across providers and resumes the parent with their results", async () => {
    const { calls, call, orchestrator, pane, texts } = setup(team())
    orchestrator.send("lead", "go")
    await settle()
    call("go").reply(
      `On it.\n${delegate({ agent: "sec", task: "audit" }, { agent: "design", task: "review" })}`,
      "lead-session",
    )
    await settle()

    expect(pane("lead").status).toBe("waiting")
    expect(call("audit").provider).toBe("codex")
    expect(call("review").provider).toBe("opencode")
    expect(pane("sec").status).toBe("running")
    expect(texts("sec")).toEqual(["user:[lead] audit"])

    call("audit").reply("XSS found")
    await settle()
    expect(pane("lead").status).toBe("waiting")
    call("review").reply("Looks fine")
    await settle()

    const followUp = calls.at(-1)!
    expect(followUp.request.sessionId).toBe("lead-session")
    expect(followUp.agentPrompt).toContain("## sec (done)\nXSS found")
    expect(followUp.agentPrompt).toContain("## design (done)\nLooks fine")
    expect(pane("lead").status).toBe("running")

    followUp.reply("Final answer")
    await settle()
    expect(pane("lead").status).toBe("done")

    const lead = texts("lead")
    expect(lead).toContain("assistant:On it.")
    expect(lead.join("\n")).not.toContain("ravex-delegate")
    expect(lead).toContain("tool:→ sec: audit")
    expect(lead).toContain("tool:← sec: done")
    expect(lead.at(-1)).toBe("assistant:Final answer")
  })

  test("removes a delegation message that had no other text", async () => {
    const { call, orchestrator, texts } = setup(team())
    orchestrator.send("lead", "go")
    await settle()
    call("go").reply(delegate({ agent: "sec", task: "audit" }))
    await settle()
    expect(texts("lead").some((text) => text.startsWith("assistant:"))).toBe(false)
  })

  test("a failing subagent becomes a result for the parent", async () => {
    const { calls, call, orchestrator } = setup(team())
    orchestrator.send("lead", "go")
    await settle()
    call("go").reply(delegate({ agent: "sec", task: "audit" }))
    await settle()
    call("audit").finish({ status: "failed", message: "token revoked" })
    await settle()
    expect(calls.at(-1)?.agentPrompt).toContain("## sec (failed)\ntoken revoked")
  })

  test("a subagent with a missing CLI becomes a failed result", async () => {
    const { calls, call, orchestrator } = setup(team(), (p) => p.id !== "codex")
    orchestrator.send("lead", "go")
    await settle()
    call("go").reply(delegate({ agent: "sec", task: "audit" }))
    await settle()
    expect(calls.at(-1)?.agentPrompt).toContain("## sec (failed)\ncodex was not found")
  })

  test("refuses agents that weren't assigned, and tells the parent", async () => {
    const { calls, call, orchestrator, texts } = setup([...team(), agent("secret")])
    orchestrator.send("lead", "go")
    await settle()
    call("go").reply(delegate({ agent: "secret", task: "steal" }))
    await settle()
    expect(calls.some((c) => c.agentPrompt === "steal")).toBe(false)
    expect(calls.at(-1)?.agentPrompt).toContain("## secret (failed)")
    expect(texts("secret")).toEqual([])
  })

  test("ignores delegation blocks from agents without subagents", async () => {
    const { calls, call, orchestrator, pane, texts } = setup(team())
    orchestrator.send("sec", "go")
    await settle()
    call("go").reply(delegate({ agent: "design", task: "x" }))
    await settle()
    expect(calls).toHaveLength(1)
    expect(pane("sec").status).toBe("done")
    expect(texts("sec").at(-1)).toContain("ravex-delegate")
  })

  test("returns a malformed block to the parent so that it can fix it", async () => {
    const { calls, call, orchestrator, texts } = setup(team())
    orchestrator.send("lead", "go")
    await settle()
    call("go").reply("```ravex-delegate\n{nope\n```", "s")
    await settle()
    expect(texts("lead")).toContain("error:The delegation block isn't valid JSON.")
    expect(calls.at(-1)?.agentPrompt).toContain("wasn't run")
    expect(calls.at(-1)?.request.sessionId).toBe("s")
  })

  test("stops a parent that keeps delegating", async () => {
    const { calls, orchestrator, pane, texts } = setup([
      agent("lead", { subagents: ["sec"] }),
      agent("sec"),
    ])
    orchestrator.send("lead", "go")
    await settle()
    for (let i = 0; i < 12 && pane("lead").status !== "failed"; i++) {
      const open = calls.at(-1)!
      if (open.agentPrompt === "loop") open.reply("result")
      else open.reply(delegate({ agent: "sec", task: "loop" }))
      await settle()
    }
    expect(pane("lead").status).toBe("failed")
    expect(texts("lead").at(-1)).toContain("Stopped after 5 rounds")
    expect(calls.filter((c) => c.agentPrompt === "loop")).toHaveLength(4)
  })

  test("runs at most 4 subagents at a time", async () => {
    const agents = [
      agent("lead", { subagents: ["a", "b", "c", "d", "e", "f"] }),
      ...["a", "b", "c", "d", "e", "f"].map((id) => agent(id)),
    ]
    const { calls, call, orchestrator } = setup(agents)
    orchestrator.send("lead", "go")
    await settle()
    call("go").reply(delegate(...["a", "b", "c", "d", "e", "f"].map((id) => ({ agent: id, task: `task-${id}` }))))
    await settle()
    expect(calls.filter((c) => c.agentPrompt.startsWith("task-"))).toHaveLength(4)

    call("task-a").reply("done")
    await settle()
    expect(calls.filter((c) => c.agentPrompt.startsWith("task-"))).toHaveLength(5)
  })

  test("tasks for the same busy agent wait their turn", async () => {
    const { calls, call, orchestrator, texts } = setup(team())
    orchestrator.send("lead", "go")
    await settle()
    call("go").reply(delegate({ agent: "sec", task: "one" }, { agent: "sec", task: "two" }))
    await settle()

    expect(calls.map((c) => c.agentPrompt)).toEqual(["go", "one"])
    expect(texts("sec")).toEqual(["user:[lead] one", "user:[lead] two"])
    call("one").reply("first")
    await settle()
    expect(calls.at(-1)?.agentPrompt).toBe("two")
    call("two").reply("second")
    await settle()
    expect(calls.at(-1)?.agentPrompt).toContain("first")
    expect(calls.at(-1)?.agentPrompt).toContain("second")
  })

  test("a subagent can delegate to its own subagents", async () => {
    const { calls, call, orchestrator, pane } = setup([
      agent("a", { subagents: ["b"] }),
      agent("b", { subagents: ["c"] }),
      agent("c"),
    ])
    orchestrator.send("a", "go")
    await settle()
    call("go").reply(delegate({ agent: "b", task: "mid" }))
    await settle()
    call("mid").reply(delegate({ agent: "c", task: "leaf" }), "b-session")
    await settle()
    expect(pane("a").status).toBe("waiting")
    expect(pane("b").status).toBe("waiting")

    call("leaf").reply("leaf result")
    await settle()
    const midFollowUp = calls.at(-1)!
    expect(midFollowUp.agentPrompt).toContain("leaf result")
    expect(midFollowUp.request.sessionId).toBe("b-session")

    midFollowUp.reply("mid result")
    await settle()
    expect(calls.at(-1)?.agentPrompt).toContain("mid result")
  })

  test("enforces the depth limit even if a file bypassed validation", async () => {
    const { calls, orchestrator, texts } = setup([
      agent("a", { subagents: ["b"] }),
      agent("b", { subagents: ["c"] }),
      agent("c", { subagents: ["d"] }),
      agent("d", { subagents: ["e"] }),
      agent("e"),
    ])
    orchestrator.send("a", "go")
    await settle()
    for (const [prompt, next] of [["go", "b"], ["to-b", "c"], ["to-c", "d"], ["to-d", "e"]] as const) {
      calls.find((c) => c.agentPrompt === prompt)?.reply(delegate({ agent: next, task: `to-${next}` }))
      await settle()
    }
    expect(calls.some((c) => c.agentPrompt === "to-e")).toBe(false)
    expect(texts("d").join("\n")).toContain("at most 3")
    expect(calls.at(-1)?.agentPrompt).toContain("## e (failed)")
  })
})

describe("permissions", () => {
  const lead = (mode: Agent["mode"]) => agent("lead", { subagents: ["sec"], mode })

  async function childMode(parent: Agent, child: Agent, sessionEdit: boolean) {
    const { call, orchestrator } = setup([parent, child])
    if (sessionEdit) orchestrator.toggleMode()
    orchestrator.send("lead", "go")
    await settle()
    const parentMode = call("go").request.mode
    call("go").reply(delegate({ agent: "sec", task: "task" }))
    await settle()
    return { parentMode, childMode: call("task").request.mode }
  }

  test("the session starts read-only, whatever the agents allow", async () => {
    expect(await childMode(lead("edit"), agent("sec", { mode: "edit" }), false)).toEqual({
      parentMode: "read-only",
      childMode: "read-only",
    })
  })

  test("an agent never exceeds its own maximum", async () => {
    expect(await childMode(lead("edit"), agent("sec", { mode: "read-only" }), true)).toEqual({
      parentMode: "edit",
      childMode: "read-only",
    })
  })

  test("a read-only parent can't get an editing child", async () => {
    expect(await childMode(lead("read-only"), agent("sec", { mode: "edit" }), true)).toEqual({
      parentMode: "read-only",
      childMode: "read-only",
    })
  })

  test("edits are allowed only when the session, parent and child all permit them", async () => {
    expect(await childMode(lead("edit"), agent("sec", { mode: "edit" }), true)).toEqual({
      parentMode: "edit",
      childMode: "edit",
    })
  })

  test("the limit holds further down a chain", async () => {
    const { call, orchestrator } = setup([
      agent("a", { subagents: ["b"], mode: "edit" }),
      agent("b", { subagents: ["c"], mode: "read-only" }),
      agent("c", { mode: "edit" }),
    ])
    orchestrator.toggleMode()
    orchestrator.send("a", "go")
    await settle()
    call("go").reply(delegate({ agent: "b", task: "mid" }))
    await settle()
    call("mid").reply(delegate({ agent: "c", task: "leaf" }))
    await settle()
    expect(call("leaf").request.mode).toBe("read-only")
  })
})

describe("cancelling", () => {
  const team = () => [
    agent("a", { subagents: ["b", "c"] }),
    agent("b", { subagents: ["d"] }),
    agent("c"),
    agent("d"),
  ]

  test("cancelling a parent stops its whole chain and doesn't resume it", async () => {
    const { calls, call, orchestrator, pane } = setup(team())
    orchestrator.send("a", "go")
    await settle()
    call("go").reply(delegate({ agent: "b", task: "mid" }, { agent: "c", task: "side" }))
    await settle()
    call("mid").reply(delegate({ agent: "d", task: "leaf" }))
    await settle()

    orchestrator.cancel("a")
    await settle()
    expect(call("side").signal.aborted).toBe(true)
    expect(call("leaf").signal.aborted).toBe(true)
    expect(pane("a").status).toBe("cancelled")
    expect(pane("b").status).toBe("cancelled")
    expect(pane("c").status).toBe("cancelled")
    expect(pane("d").status).toBe("cancelled")
    expect(calls).toHaveLength(4)
  })

  test("cancelling a subagent stops only it, and the parent continues", async () => {
    const { calls, call, orchestrator, pane } = setup(team())
    orchestrator.send("a", "go")
    await settle()
    call("go").reply(delegate({ agent: "c", task: "side" }))
    await settle()

    orchestrator.cancel("c")
    await settle()
    expect(pane("a").status).toBe("running")
    expect(calls.at(-1)?.agentPrompt).toContain("## c (cancelled)")
  })

  test("a cancelled queued task never starts, and the next one still does", async () => {
    const { calls, call, orchestrator, pane } = setup(team())
    orchestrator.send("c", "direct")
    orchestrator.send("a", "go")
    await settle()
    call("go").reply(delegate({ agent: "c", task: "queued" }))
    await settle()

    orchestrator.cancel("a")
    await settle()
    expect(calls.some((c) => c.agentPrompt === "queued")).toBe(false)
    expect(pane("c").status).toBe("running")

    call("direct").reply("done")
    await settle()
    expect(pane("c").status).toBe("done")
    orchestrator.send("c", "later")
    await settle()
    expect(calls.at(-1)?.agentPrompt).toBe("later")
  })

  test("cancelling all stops every agent, including directly messaged subagents", async () => {
    const { calls, orchestrator } = setup(team())
    orchestrator.send("a", "one")
    orchestrator.send("d", "two")
    await settle()
    orchestrator.cancel(ALL_AGENTS)
    expect(calls.map((c) => c.signal.aborted)).toEqual([true, true])
  })

  test("an agent is free again after being cancelled", async () => {
    const { calls, orchestrator } = setup(team())
    orchestrator.send("c", "one")
    await settle()
    expect(orchestrator.isBusy("c")).toBe(true)
    orchestrator.cancel("c")
    await settle()
    expect(orchestrator.isBusy("c")).toBe(false)
    orchestrator.send("c", "two")
    await settle()
    expect(calls).toHaveLength(2)
  })
})
