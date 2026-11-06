import { describe, expect, test } from "bun:test"
import type { Agent } from "../agents/types.ts"
import type { RunTurn, TurnResult } from "../providers/runner.ts"
import type { Provider, ProviderEvent, ProviderId, TurnRequest } from "../providers/types.ts"
import type { TeamSnapshot } from "./persistence.ts"
import { MAX_ROOM_REPLIES } from "./room.ts"
import { tasksLimitedByMode, Team, type TeamOptions } from "./team.ts"

const fake = (id: ProviderId): Provider => ({ id, label: id, binary: id, buildArgs: () => [], parseLine: () => [] })
const providers = [fake("claude"), fake("codex"), fake("opencode")]

const agent = (id: string, overrides: Partial<Agent> = {}): Agent => ({
  id,
  name: id.toUpperCase(),
  description: `does ${id}`,
  provider: "claude",
  instructions: `own-${id}`,
  mode: "edit",
  origin: "global",
  ...overrides,
})

// Every agent has its own model here, which is how a fake run tells them apart.
const team = (ids: string[]) => ids.map((id) => agent(id, { model: id }))

interface Call {
  agent: string
  request: TurnRequest
  emit: (event: ProviderEvent) => void
  finish: (result?: TurnResult) => void
  /** Sends text, then finishes the turn. */
  reply: (text: string, sessionId?: string) => void
  signal: AbortSignal
}

function setup(ids = ["lead", "a", "b", "c", "d", "e"], options: TeamOptions = {}) {
  const calls: Call[] = []
  const run: RunTurn = (_provider, request, onEvent, signal) =>
    new Promise((resolve) => {
      const finish = (result: TurnResult = { status: "done" }) => resolve(result)
      calls.push({
        agent: request.model ?? "",
        request,
        emit: onEvent,
        finish,
        reply: (text, sessionId) => {
          if (sessionId) onEvent({ type: "session", sessionId })
          onEvent({ type: "text-start" })
          onEvent({ type: "text-delta", text })
          finish()
        },
        signal,
      })
      signal.addEventListener("abort", () => resolve({ status: "cancelled" }))
    })
  const instance = new Team(providers, team(ids), "lead", { run, isAvailable: () => true, ...options })
  const last = (name: string) => calls.findLast((call) => call.agent === name) as Call
  return { team: instance, calls, last, state: () => instance.getState() }
}

const settle = () => Bun.sleep(5)
const plan = (tasks: object[], extra: object = {}) =>
  `Plan.\n\`\`\`ravex-plan\n${JSON.stringify({ tasks, ...extra })}\n\`\`\``
const item = (key: string, agentId: string, overrides: object = {}) => ({
  key,
  title: `T-${key}`,
  description: `do ${key}`,
  agent: agentId,
  ...overrides,
})
const statuses = (state: ReturnType<ReturnType<typeof setup>["state"]>) =>
  state.board.tasks.map((task) => `${task.id}:${task.status}`)
const entries = (state: ReturnType<ReturnType<typeof setup>["state"]>, id: string) =>
  state.panes.find((pane) => pane.id === id)?.entries.map((entry) => entry.text) ?? []

async function proposed(ctx: ReturnType<typeof setup>, tasks: object[]) {
  ctx.team.sendToOrchestrator("the goal")
  await settle()
  ctx.last("lead").reply(plan(tasks))
  await settle()
}

async function approved(ctx: ReturnType<typeof setup>, tasks: object[]) {
  await proposed(ctx, tasks)
  ctx.team.toggleMode()
  ctx.team.approve()
  await settle()
}

describe("planning", () => {
  test("the orchestrator gets the team and plans read-only, even in edit mode", async () => {
    const ctx = setup()
    ctx.team.toggleMode()
    ctx.team.sendToOrchestrator("  add a login  ")
    await settle()

    const call = ctx.last("lead")
    expect(ctx.state().board.phase).toBe("planning")
    expect(call.request.prompt).toBe("add a login")
    expect(call.request.mode).toBe("read-only")
    expect(call.request.instructions).toContain("own-lead")
    expect(call.request.instructions).toContain("- a: does a (claude/a; tools: all)")
    expect(call.request.instructions).not.toContain("- lead:")
    expect(call.request.instructions).toContain("ravex-plan")
  })

  test("a plan is only proposed: nothing runs before approval", async () => {
    const ctx = setup()
    await proposed(ctx, [item("x", "a"), item("y", "b", { dependsOn: ["x"] })])

    expect(ctx.state().board.phase).toBe("proposed")
    expect(ctx.state().board.goal).toBe("the goal")
    expect(statuses(ctx.state())).toEqual(["1:proposed", "2:proposed"])
    expect(ctx.calls.map((call) => call.agent)).toEqual(["lead"])
    // The block doesn't stay in the conversation.
    expect(entries(ctx.state(), "lead").join()).not.toContain("ravex-plan")
    expect(entries(ctx.state(), "lead")).toContain("Plan.")
  })

  test("an answer without a plan changes nothing", async () => {
    const ctx = setup()
    ctx.team.sendToOrchestrator("hi")
    await settle()
    ctx.last("lead").reply("Hello!")
    await settle()
    expect(ctx.state().board.phase).toBe("idle")
    expect(ctx.state().board.goal).toBeUndefined()
    expect(ctx.state().board.tasks).toEqual([])
  })

  test("refuses another message while planning", async () => {
    const ctx = setup()
    ctx.team.sendToOrchestrator("one")
    await settle()
    expect(ctx.team.sendToOrchestrator("two")).toContain("working")
    expect(ctx.calls.length).toBe(1)
  })

  test("the orchestrator can't assign work to itself or to unknown agents, and gets one chance to fix it", async () => {
    const ctx = setup()
    ctx.team.sendToOrchestrator("goal")
    await settle()
    ctx.last("lead").reply(plan([item("x", "lead")]))
    await settle()
    expect(ctx.state().board.tasks).toEqual([])
    expect(ctx.last("lead").request.prompt).toContain("wasn't accepted")

    ctx.last("lead").reply(plan([item("x", "ghost")]))
    await settle()
    expect(ctx.calls.length).toBe(2)
    expect(ctx.state().board.phase).toBe("idle")
    expect(entries(ctx.state(), "lead").join()).toContain("Invalid plan")
  })

  test("a corrected plan is accepted", async () => {
    const ctx = setup()
    ctx.team.sendToOrchestrator("goal")
    await settle()
    ctx.last("lead").reply(plan([item("x", "ghost")]))
    await settle()
    ctx.last("lead").reply(plan([item("x", "a")]))
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:proposed"])
  })

  test("doesn't offer agents that aren't installed", () => {
    const limited = new Team(providers, [agent("lead"), agent("x", { provider: "codex" }), agent("y")], "lead", {
      isAvailable: (provider) => provider.id === "claude",
      run: async () => ({ status: "done" }),
    })
    expect(limited.workers().map((worker) => worker.id)).toEqual(["y"])
  })

  test("writing on a proposal asks for a new plan that replaces it", async () => {
    const ctx = setup()
    await proposed(ctx, [item("x", "a"), item("y", "b")])

    expect(ctx.team.sendToOrchestrator("use only b")).toBeUndefined()
    await settle()
    const call = ctx.last("lead")
    expect(call.request.prompt).toContain("use only b")
    // It's the same conversation, and the proposal is still there until the new one arrives.
    expect(ctx.state().board.phase).toBe("planning")
    expect(statuses(ctx.state())).toEqual(["1:proposed", "2:proposed"])
    expect(ctx.team.approve()).toBeDefined()

    call.reply(plan([item("z", "b")]))
    await settle()
    expect(ctx.state().board.tasks.map((task) => [task.id, task.title])).toEqual([[1, "T-z"]])
    expect(ctx.state().board.replans).toBe(1)
  })

  test("an answer without a plan keeps the current proposal", async () => {
    const ctx = setup()
    await proposed(ctx, [item("x", "a")])
    ctx.team.sendToOrchestrator("why?")
    await settle()
    ctx.last("lead").reply("Because.")
    await settle()
    expect(ctx.state().board.phase).toBe("proposed")
    expect(statuses(ctx.state())).toEqual(["1:proposed"])
  })

  test("limits replans", async () => {
    const ctx = setup()
    await proposed(ctx, [item("x", "a")])
    for (let count = 0; count < 3; count++) {
      ctx.team.sendToOrchestrator("again")
      await settle()
      ctx.last("lead").reply(plan([item("x", "a")]))
      await settle()
    }
    const before = ctx.calls.length
    expect(ctx.team.sendToOrchestrator("again")).toContain("limit")
    await settle()
    expect(ctx.calls.length).toBe(before)
  })

  test("discarding removes the proposal", async () => {
    const ctx = setup()
    await proposed(ctx, [item("x", "a")])
    ctx.team.discardPlan()
    expect(ctx.state().board.phase).toBe("idle")
    expect(ctx.state().board.tasks).toEqual([])
    await settle()
    expect(ctx.calls.length).toBe(1)
  })

  test("reassigning validates the agent, and clears a reviewer who'd review their own work", async () => {
    const ctx = setup()
    await proposed(ctx, [item("x", "a", { reviewer: "b" })])

    expect(ctx.team.reassign(1, "ghost")).toContain("isn't available")
    expect(ctx.team.reassign(1, "lead")).toContain("isn't available")
    expect(ctx.team.reassign(99, "b")).toContain("doesn't exist")
    expect(ctx.team.reassign(1, "c")).toBeUndefined()
    expect(ctx.state().board.tasks[0]).toMatchObject({ assignee: "c", reviewer: "b" })
    expect(ctx.team.reassign(1, "b")).toBeUndefined()
    expect(ctx.state().board.tasks[0]?.assignee).toBe("b")
    expect(ctx.state().board.tasks[0]?.reviewer).toBeUndefined()

    ctx.team.toggleMode()
    ctx.team.approve()
    await settle()
    expect(ctx.last("b").request.prompt).toContain("do x")
    expect(ctx.team.reassign(1, "a")).toContain("running")
  })

  test("warns that approving doesn't grant permissions, and it really doesn't", async () => {
    const ctx = setup()
    await proposed(ctx, [item("x", "a", { edits: true }), item("y", "b")])
    expect(tasksLimitedByMode(ctx.state()).map((task) => task.id)).toEqual([1])

    expect(ctx.team.approve()).toContain("Approving doesn't grant permissions")
    await settle()
    expect(ctx.last("a").request.mode).toBe("read-only")
    expect(ctx.last("a").request.instructions).toContain("read-only")
  })

  test("rejects an editing task for an agent without the tools, and limits one reassigned to it", async () => {
    const ctx = setup(["lead", "a", "b"])
    ctx.team.setTeam(
      [
        agent("lead", { model: "lead" }),
        agent("a", { model: "a", mode: "read-only", tools: ["web"] }),
        agent("b", { model: "b" }),
      ],
      "lead",
    )
    ctx.team.toggleMode()
    ctx.team.sendToOrchestrator("goal")
    await settle()
    ctx.last("lead").reply(plan([item("x", "a", { edits: true })]))
    await settle()
    expect(ctx.last("lead").request.prompt).toContain("has no tools")

    ctx.last("lead").reply(plan([item("x", "b", { edits: true })]))
    await settle()
    ctx.team.reassign(1, "a")
    expect(ctx.team.approve()).toContain("Approving doesn't grant permissions")
    await settle()
    expect(ctx.last("a").request.mode).toBe("read-only")
  })
})

describe("tools and skills", () => {
  const custom = () => [
    agent("lead", { model: "lead", skills: ["plan-well"] }),
    agent("a", { model: "a", tools: ["edit", "web"], skills: ["style", "ghost"] }),
    agent("b", { model: "b" }),
  ]
  const resolveSkills = (names: string[]) => ({
    text: names.includes("style") ? "# Skill: style" : "# Skill: plan-well",
    missing: names.filter((name) => name === "ghost"),
  })

  test("every kind of turn gets the agent's skills and tools", async () => {
    const ctx = setup(["lead", "a", "b"], { resolveSkills })
    ctx.team.setTeam(custom(), "lead")
    ctx.team.toggleMode()

    ctx.team.sendToAgent("a", "hi")
    await settle()
    expect(ctx.last("a").request.instructions).toContain("# Skill: style")
    expect(ctx.last("a").request.instructions).toContain("own-a")
    expect(ctx.last("a").request.tools).toEqual(["edit", "web"])
    expect(ctx.last("a").request.nativeSkills).toBe(false)
    ctx.last("a").reply("ok")
    await settle()

    ctx.team.sendToRoom("@a hi")
    await settle()
    expect(ctx.last("a").request.instructions).toContain("# Skill: style")
    expect(ctx.last("a").request.mode).toBe("read-only")
    ctx.last("a").reply("ok")
    await settle()

    await proposed(ctx, [item("x", "a", { reviewer: "b" })])
    expect(ctx.last("lead").request.instructions).toContain("# Skill: plan-well")
    ctx.team.approve()
    await settle()
    expect(ctx.last("a").request.instructions).toContain("# Skill: style")
    expect(ctx.last("a").request.prompt).toContain("do x")
  })

  test("agents that don't choose skills keep the ones their CLI finds", async () => {
    const ctx = setup(["lead", "b"], { resolveSkills })
    ctx.team.setTeam(custom(), "lead")
    ctx.team.sendToAgent("b", "hi")
    await settle()
    expect(ctx.last("b").request.nativeSkills).toBe(true)
    expect(ctx.last("b").request.tools).toBeUndefined()
    expect(ctx.last("b").request.instructions).toBe("own-b")
  })

  test("reports a skill that no longer exists", async () => {
    const ctx = setup(["lead", "a"], { resolveSkills })
    ctx.team.setTeam(custom(), "lead")
    ctx.team.sendToAgent("a", "hi")
    await settle()
    expect(entries(ctx.state(), "a").join()).toContain("Skills not found: ghost")
  })

  test("tells the orchestrator what each member can do", async () => {
    const ctx = setup(["lead", "a"], { resolveSkills })
    ctx.team.setTeam(custom(), "lead")
    ctx.team.sendToOrchestrator("goal")
    await settle()
    expect(ctx.last("lead").request.instructions).toContain("(claude/a; tools: read, edit, web; skills: style, ghost)")
    expect(ctx.last("lead").request.instructions).toContain("- b: does b (claude/b; tools: all)")
  })

  test("changing an agent's tools or skills starts a new conversation", async () => {
    const ctx = setup(["lead", "a"])
    ctx.team.sendToAgent("a", "hi")
    await settle()
    ctx.last("a").reply("hello", "s1")
    await settle()
    ctx.team.setTeam([agent("lead", { model: "lead" }), agent("a", { model: "a", tools: ["web"] })], "lead")
    ctx.team.sendToAgent("a", "again")
    await settle()
    expect(ctx.last("a").request.sessionId).toBeUndefined()
  })
})

describe("dispatching", () => {
  test("runs tasks in dependency order and passes results along", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a"), item("y", "b", { dependsOn: ["x"] })])

    expect(statuses(ctx.state())).toEqual(["1:running", "2:todo"])
    expect(ctx.state().board.phase).toBe("running")
    const first = ctx.last("a")
    expect(first.request.prompt).toContain("Team goal: the goal")
    expect(first.request.prompt).toContain("Your task #1: T-x")
    expect(first.request.instructions).toContain("own-a")
    expect(first.request.mode).toBe("read-only")

    first.reply("Found the-secret-result")
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:done", "2:running"])
    expect(ctx.last("b").request.prompt).toContain("Found the-secret-result")
  })

  test("a task that edits gets edit mode, and only one edits at a time", async () => {
    const ctx = setup()
    await approved(ctx, [
      item("x", "a", { edits: true }),
      item("y", "b", { edits: true }),
      item("z", "c"),
    ])
    expect(statuses(ctx.state())).toEqual(["1:running", "2:todo", "3:running"])
    expect(ctx.last("a").request.mode).toBe("edit")
    expect(ctx.last("a").request.instructions).toContain("may change files")
    expect(ctx.last("c").request.mode).toBe("read-only")

    ctx.last("a").reply("done")
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:done", "2:running", "3:running"])
    expect(ctx.last("b").request.mode).toBe("edit")
  })

  test("runs at most 4 at once", async () => {
    const ctx = setup()
    await approved(ctx, ["a", "b", "c", "d", "e"].map((id) => item(id, id)))
    expect(statuses(ctx.state()).filter((status) => status.endsWith("running")).length).toBe(4)
    ctx.last("a").reply("done")
    await settle()
    expect(ctx.last("e")).toBeDefined()
  })

  test("an agent never runs two tasks at once", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a"), item("y", "a")])
    expect(statuses(ctx.state())).toEqual(["1:running", "2:todo"])
  })

  test("resumes the orchestrator with the results when everything finishes", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a")])
    ctx.last("a").reply("Result-of-x")
    await settle()

    const call = ctx.last("lead")
    expect(ctx.state().board.phase).toBe("wrapping-up")
    expect(call.request.prompt).toContain("Result-of-x")
    expect(call.request.mode).toBe("read-only")
    call.reply("All good.")
    await settle()
    expect(ctx.state().board.phase).toBe("idle")
    expect(entries(ctx.state(), "lead")).toContain("All good.")
  })

  test("the orchestrator keeps its conversation across turns", async () => {
    const ctx = setup()
    ctx.team.sendToOrchestrator("first")
    await settle()
    ctx.last("lead").reply(plan([item("x", "a")]), "lead-session")
    await settle()
    ctx.team.toggleMode()
    ctx.team.approve()
    await settle()
    ctx.last("a").reply("ok")
    await settle()
    expect(ctx.last("lead").request.sessionId).toBe("lead-session")
  })

  test("a new goal after finishing starts a clean board with new numbers", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a")])
    ctx.last("a").reply("ok")
    await settle()
    ctx.last("lead").reply("Done.")
    await settle()

    ctx.team.sendToOrchestrator("second goal")
    await settle()
    ctx.last("lead").reply(plan([item("y", "b")]))
    await settle()
    expect(ctx.state().board.goal).toBe("second goal")
    expect(statuses(ctx.state())).toEqual(["2:proposed"])
  })

  test("a failure makes dependents wait and asks the orchestrator what to do", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a"), item("y", "b", { dependsOn: ["x"] }), item("z", "c")])

    ctx.last("a").finish({ status: "failed", message: "boom" })
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:failed", "2:todo", "3:running"])
    expect(ctx.state().board.phase).toBe("running")

    ctx.last("c").reply("fine")
    await settle()
    const call = ctx.last("lead")
    expect(ctx.state().board.phase).toBe("planning")
    expect(call.request.prompt).toContain("boom")
    // Its new plan needs approval too.
    call.reply(plan([], { retry: [1, 2] }))
    await settle()
    expect(ctx.state().board.phase).toBe("proposed")
    expect(ctx.state().board.pendingRetry).toEqual([1, 2])
    const before = ctx.calls.length
    await settle()
    expect(ctx.calls.length).toBe(before)

    ctx.team.approve()
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:running", "2:todo", "3:done"])
    expect(ctx.state().board.tasks[0]?.result).toBeUndefined()
  })

  test("tasks left out of a new plan are cancelled", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a"), item("y", "b", { dependsOn: ["x"] })])
    ctx.last("a").finish({ status: "failed", message: "boom" })
    await settle()
    ctx.last("lead").reply(plan([item("new", "c")]))
    await settle()
    ctx.team.approve()
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:cancelled", "2:cancelled", "3:running"])
  })

  test("a blocked task asks in the chat, and the user's reply becomes a comment", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a")])
    ctx.last("a").reply('Stuck.\n```ravex-task\n{"status":"blocked","summary":"Which database?"}\n```')
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:blocked"])
    expect(entries(ctx.state(), "lead").join()).toContain("Which database?")
    expect(ctx.last("lead").request.prompt).toContain("Which database?")

    ctx.last("lead").reply("Which database should it use?")
    await settle()
    expect(ctx.state().board.phase).toBe("paused")

    ctx.team.sendToOrchestrator("postgres")
    await settle()
    expect(ctx.state().board.tasks[0]?.comments).toEqual([{ author: "you", text: "postgres" }])
    ctx.last("lead").reply(plan([], { retry: [1] }))
    await settle()
    ctx.team.approve()
    await settle()
    expect(ctx.last("a").request.prompt).toContain("you: postgres")
  })

  test("stops asking the orchestrator once the replans run out", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a")])
    for (let count = 0; count < 3; count++) {
      ctx.last("a").finish({ status: "failed", message: "boom" })
      await settle()
      ctx.last("lead").reply(plan([], { retry: [1] }))
      await settle()
      ctx.team.approve()
      await settle()
    }
    const before = ctx.calls.length
    ctx.last("a").finish({ status: "failed", message: "boom" })
    await settle()
    expect(ctx.calls.length).toBe(before)
    expect(ctx.state().board.phase).toBe("paused")
    expect(ctx.team.sendToOrchestrator("try again")).toContain("limit")

    ctx.team.closeGoal()
    expect(ctx.state().board.phase).toBe("idle")
    expect(statuses(ctx.state())).toEqual(["1:cancelled"])
  })

  test("stopping cancels what's running and keeps the rest for later, without spending quota", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a"), item("y", "b", { dependsOn: ["x"] })])
    const before = ctx.calls.length

    ctx.team.stopWork()
    await settle()
    expect(ctx.last("a").signal.aborted).toBe(true)
    expect(statuses(ctx.state())).toEqual(["1:cancelled", "2:todo"])
    expect(ctx.state().board.phase).toBe("paused")
    expect(ctx.calls.length).toBe(before)
  })

  test("cancelling one agent's task pauses its dependents without asking the orchestrator", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a"), item("y", "b", { dependsOn: ["x"] }), item("z", "c")])
    ctx.team.cancelAgent("a")
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:cancelled", "2:todo", "3:running"])
    expect(ctx.last("c").signal.aborted).toBe(false)
    ctx.last("c").reply("ok")
    await settle()
    expect(ctx.state().board.phase).toBe("paused")
    expect(ctx.calls.filter((call) => call.agent === "lead").length).toBe(1)
  })

  test("resume continues paused work that can run, and says so when nothing can", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a"), item("y", "b", { dependsOn: ["x"] })])
    ctx.team.stopWork()
    await settle()
    expect(ctx.team.resume()).toContain("No tasks")
    expect(ctx.state().board.phase).toBe("paused")

    const other = setup()
    await approved(other, [item("x", "a"), item("y", "a")])
    other.team.stopWork()
    await settle()
    expect(statuses(other.state())).toEqual(["1:cancelled", "2:todo"])
    expect(other.team.resume()).toBeUndefined()
    await settle()
    expect(statuses(other.state())).toEqual(["1:cancelled", "2:running"])
  })

  test("while tasks run, the orchestrator can talk but can't start a plan", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a")])
    ctx.team.sendToOrchestrator("how is it going?")
    await settle()
    const call = ctx.last("lead")
    expect(call.request.prompt).toContain("how is it going?")
    expect(call.request.prompt).toContain("1 running")
    call.reply(plan([item("sneaky", "b")]))
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:running"])
    expect(ctx.state().board.phase).toBe("running")
    expect(entries(ctx.state(), "lead").join()).toContain("Plan ignored")
  })

  test("comments reach the agent on its next turn, and agents can leave them too", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a"), item("y", "b", { dependsOn: ["x"] })])
    ctx.team.comment(2, "  mind the tests ")
    ctx.team.comment(2, "   ")
    ctx.last("a").reply('Done.\n```ravex-task\n{"status":"done","summary":"s","comment":"note from a"}\n```')
    await settle()
    expect(ctx.state().board.tasks[0]?.comments).toEqual([{ author: "a", text: "note from a" }])
    expect(ctx.last("b").request.prompt).toContain("you: mind the tests")
  })

  test("the task's conversation is tagged, and the agent's session survives a retry", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a")])
    ctx.last("a").reply("Stuck.\n```ravex-task\n{\"status\":\"blocked\",\"summary\":\"s\"}\n```", "task-session")
    await settle()
    const pane = ctx.state().panes.find((candidate) => candidate.id === "a")
    expect(pane?.entries.every((entry) => entry.taskId === 1)).toBe(true)

    ctx.last("lead").reply(plan([], { retry: [1] }))
    await settle()
    ctx.team.approve()
    await settle()
    expect(ctx.last("a").request.sessionId).toBe("task-session")
  })
})

describe("review", () => {
  const reviewed = (verdict: string) => `\`\`\`ravex-review\n{"verdict":"${verdict}","comment":"${verdict} note"}\n\`\`\``

  test("an approved review finishes the task, and its dependents wait for that", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a", { reviewer: "b", edits: true }), item("y", "c", { dependsOn: ["x"] })])

    ctx.last("a").reply("Work done")
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:review", "2:todo"])
    const review = ctx.last("b")
    expect(review.request.mode).toBe("read-only")
    expect(review.request.prompt).toContain("Work done")

    review.reply(reviewed("approved"))
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:done", "2:running"])
  })

  test("requested changes go back to the agent with the comment", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a", { reviewer: "b" })])
    ctx.last("a").reply("v1")
    await settle()
    ctx.last("b").reply(reviewed("changes"))
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:running"])
    expect(ctx.last("a").request.prompt).toContain("changes note")
  })

  test("blocks after 2 rounds of changes", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a", { reviewer: "b" })])
    for (let round = 0; round < 2; round++) {
      ctx.last("a").reply("again")
      await settle()
      ctx.last("b").reply(reviewed("changes"))
      await settle()
    }
    expect(statuses(ctx.state())).toEqual(["1:running"])
    ctx.last("a").reply("again")
    await settle()
    ctx.last("b").reply(reviewed("changes"))
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:blocked"])
    expect(ctx.state().board.tasks[0]?.reviewRounds).toBe(2)
  })

  test("a review without a verdict isn't an approval", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a", { reviewer: "b" })])
    ctx.last("a").reply("v1")
    await settle()
    ctx.last("b").reply("Seems fine")
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:blocked"])
  })

  test("an agent asking for review without a reviewer gets the orchestrator", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a")])
    ctx.last("a").reply('v1\n```ravex-task\n{"status":"review","summary":"check this"}\n```')
    await settle()
    expect(ctx.state().board.tasks[0]).toMatchObject({ status: "review", reviewer: "lead" })
    expect(ctx.last("lead").request.prompt).toContain("Review task #1")
  })
})

describe("room", () => {
  test("nobody replies without a mention, so it costs nothing", async () => {
    const ctx = setup()
    expect(ctx.team.sendToRoom("hello everyone")).toContain("mention")
    await settle()
    expect(ctx.calls).toEqual([])
    expect(ctx.state().room[0]).toMatchObject({ kind: "user", text: "hello everyone" })
  })

  test("reports mentions of nobody", async () => {
    const ctx = setup()
    ctx.team.sendToRoom("@ghost hi")
    expect(ctx.state().room.at(-1)?.text).toContain("@ghost")
  })

  test("a mentioned agent gets recent messages and is always read-only, even in edit mode", async () => {
    const ctx = setup()
    ctx.team.toggleMode()
    ctx.team.sendToRoom("first idea")
    ctx.team.sendToRoom("@a what do you think?")
    await settle()

    const call = ctx.last("a")
    expect(call.request.mode).toBe("read-only")
    expect(call.request.prompt).toContain("user: first idea")
    expect(call.request.prompt).toContain("user: @a what do you think?")
    expect(call.request.instructions).toContain("own-a")
    expect(call.request.sessionId).toBeUndefined()
    expect(ctx.state().roomBusy).toBe("a")

    call.reply("I agree")
    await settle()
    expect(ctx.state().roomBusy).toBeUndefined()
    expect(ctx.state().room.at(-1)).toMatchObject({ kind: "agent", author: "a", text: "I agree" })
  })

  test("agents can call each other, seeing the previous replies", async () => {
    const ctx = setup()
    ctx.team.sendToRoom("@a start")
    await settle()
    ctx.last("a").reply("@b your turn")
    await settle()
    const call = ctx.last("b")
    expect(call.request.mode).toBe("read-only")
    expect(call.request.prompt).toContain("@a: @b your turn")
    call.reply("Done.")
    await settle()
    expect(ctx.calls.length).toBe(2)
  })

  test("an agent mentioning itself doesn't loop", async () => {
    const ctx = setup()
    ctx.team.sendToRoom("@a go")
    await settle()
    ctx.last("a").reply("I, @a, did it")
    await settle()
    expect(ctx.calls.length).toBe(1)
  })

  test(`stops after ${MAX_ROOM_REPLIES} chained replies`, async () => {
    const ctx = setup()
    ctx.team.sendToRoom("@a go")
    await settle()
    for (let turn = 0; turn < MAX_ROOM_REPLIES; turn++) {
      const current = ctx.calls.at(-1) as Call
      current.reply(current.agent === "a" ? "@b go" : "@a go")
      await settle()
    }
    expect(ctx.calls.length).toBe(MAX_ROOM_REPLIES)
    expect(ctx.state().room.at(-1)?.text).toContain("limit")
  })

  test("cancelling stops the chain", async () => {
    const ctx = setup()
    ctx.team.sendToRoom("@a @b go")
    await settle()
    ctx.team.cancelRoom()
    await settle()
    expect(ctx.calls.length).toBe(1)
    expect(ctx.last("a").signal.aborted).toBe(true)
    expect(ctx.state().roomBusy).toBeUndefined()
  })

  test("a failed reply is reported and the chain goes on", async () => {
    const ctx = setup()
    ctx.team.sendToRoom("@a @b go")
    await settle()
    ctx.last("a").finish({ status: "failed", message: "boom" })
    await settle()
    expect(ctx.state().room.at(-1)?.kind).toBe("error")
    expect(ctx.last("b")).toBeDefined()
  })

  test("shows board events, and agents can post from a task", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a")])
    expect(ctx.state().room.at(-1)?.text).toContain("A started task 1")
    ctx.last("a").reply('Ok.\n```ravex-task\n{"status":"done","summary":"s","room":"Hey @b look"}\n```')
    await settle()
    expect(ctx.state().room.some((message) => message.kind === "agent" && message.text === "Hey @b look")).toBe(true)
    expect(ctx.last("b").request.prompt).toContain("Hey @b look")
  })
})

describe("direct chat", () => {
  test("keeps its own conversation and respects the lowest mode", async () => {
    const ctx = setup()
    ctx.team.sendToAgent("a", "hi")
    await settle()
    expect(ctx.last("a").request.mode).toBe("read-only")
    expect(ctx.last("a").request.instructions).toBe("own-a")
    ctx.last("a").reply("hello", "direct-session")
    await settle()
    ctx.team.toggleMode()
    ctx.team.sendToAgent("a", "again")
    await settle()
    expect(ctx.last("a").request.mode).toBe("edit")
    expect(ctx.last("a").request.sessionId).toBe("direct-session")
  })

  test("can't edit while a task edits", async () => {
    const ctx = setup()
    await approved(ctx, [item("x", "a", { edits: true })])
    ctx.team.sendToAgent("b", "hi")
    await settle()
    expect(ctx.last("b").request.mode).toBe("read-only")
    expect(entries(ctx.state(), "b").join()).toContain("read-only")
  })

  test("an editing chat holds back editing tasks until it finishes", async () => {
    const ctx = setup()
    ctx.team.toggleMode()
    ctx.team.sendToAgent("b", "edit something")
    await settle()
    expect(ctx.last("b").request.mode).toBe("edit")

    ctx.team.sendToOrchestrator("goal")
    await settle()
    ctx.last("lead").reply(plan([item("x", "a", { edits: true })]))
    await settle()
    ctx.team.approve()
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:todo"])
    expect(ctx.state().board.phase).toBe("running")

    ctx.last("b").reply("edited")
    await settle()
    expect(statuses(ctx.state())).toEqual(["1:running"])
  })
})

describe("persistence", () => {
  function memory() {
    const saved: { last?: TeamSnapshot } = {}
    return {
      saved,
      persistence: {
        save: (snapshot: TeamSnapshot) => {
          saved.last = JSON.parse(JSON.stringify(snapshot)) as TeamSnapshot
        },
      },
    }
  }

  test("closing mid-work kills the turn and saves it so it comes back as interrupted", async () => {
    const { saved, persistence } = memory()
    const ctx = setup(undefined, { persistence })
    await approved(ctx, [item("x", "a", { edits: true }), item("y", "b", { dependsOn: ["x"] })])
    ctx.last("a").emit({ type: "text-start" })
    ctx.last("a").emit({ type: "text-delta", text: "partial work" })

    ctx.team.stop()
    expect(ctx.last("a").signal.aborted).toBe(true)
    await settle()
    expect(saved.last?.board.tasks[0]?.status).toBe("running")

    const reopened = setup(undefined, { snapshot: saved.last })
    expect(statuses(reopened.state())).toEqual(["1:todo", "2:todo"])
    expect(reopened.state().board.phase).toBe("paused")
    expect(reopened.state().board.tasks[0]?.comments[0]?.text).toContain("Interrupted")
    expect(entries(reopened.state(), "a").join()).toContain("partial work")
    expect(reopened.state().mode).toBe("read-only")

    // It doesn't spend quota until asked.
    await settle()
    expect(reopened.calls).toEqual([])

    // The session's mode isn't restored, so an edit doesn't resume with more than was asked for.
    expect(reopened.team.resume()).toContain("Continuing doesn't grant permissions")
    await settle()
    expect(reopened.last("a").request.mode).toBe("read-only")
    expect(reopened.last("a").request.prompt).toContain("Your task #1")
    expect(reopened.last("a").request.prompt).toContain("Interrupted")
  })

  test("restores conversations and room, so sessions and numbering continue", async () => {
    const { saved, persistence } = memory()
    const ctx = setup(undefined, { persistence })
    ctx.team.sendToOrchestrator("hi")
    await settle()
    ctx.last("lead").reply("Hello", "lead-session")
    await settle()
    ctx.team.sendToRoom("nobody here")
    ctx.team.stop()

    const reopened = setup(undefined, { snapshot: saved.last })
    expect(entries(reopened.state(), "lead")).toEqual(["hi", "Hello"])
    expect(reopened.state().room.map((message) => message.text)).toEqual(["nobody here"])

    reopened.team.sendToOrchestrator("again")
    reopened.team.sendToRoom("second")
    await settle()
    expect(reopened.last("lead").request.sessionId).toBe("lead-session")
    const ids = reopened.state().room.map((message) => message.id)
    expect(new Set(ids).size).toBe(ids.length)
    const entryIds = reopened.state().panes.find((pane) => pane.id === "lead")?.entries.map((entry) => entry.id) ?? []
    expect(new Set(entryIds).size).toBe(entryIds.length)
  })

  test("keeps a proposal across restarts", async () => {
    const { saved, persistence } = memory()
    const ctx = setup(undefined, { persistence })
    await proposed(ctx, [item("x", "a")])
    ctx.team.stop()
    const reopened = setup(undefined, { snapshot: saved.last })
    expect(reopened.state().board.phase).toBe("proposed")
    reopened.team.toggleMode()
    reopened.team.approve()
    await settle()
    expect(reopened.last("a")).toBeDefined()
  })

  test("saves on its own after changes, and reports a failed save", async () => {
    const { saved, persistence } = memory()
    const ctx = setup(undefined, { persistence })
    ctx.team.sendToRoom("hello")
    expect(saved.last).toBeUndefined()
    await Bun.sleep(550)
    expect(saved.last?.room[0]?.text).toBe("hello")

    const broken = setup(undefined, { persistence: { save: () => { throw new Error("disk full") } } })
    broken.team.flush()
    expect(broken.state().saveError).toBe("disk full")
  })
})

describe("the team", () => {
  test("keeps conversations when the team changes, and restarts an agent whose engine changed", async () => {
    const ctx = setup(["lead", "a"])
    ctx.team.sendToAgent("a", "hi")
    await settle()
    ctx.last("a").reply("hello", "s1")
    await settle()

    const changed = [agent("lead", { model: "lead" }), agent("a", { model: "a2" })]
    ctx.team.setTeam(changed, "lead")
    expect(entries(ctx.state(), "a").join()).toContain("hello")
    ctx.team.sendToAgent("a", "again")
    await settle()
    expect(ctx.calls.at(-1)?.request.sessionId).toBeUndefined()
  })

  test("any agent can be the orchestrator", async () => {
    const ctx = setup(["lead", "a"])
    ctx.team.setTeam(ctx.state().agents, "a")
    ctx.team.sendToOrchestrator("goal")
    await settle()
    expect(ctx.last("a").request.instructions).toContain("- lead:")
    expect(ctx.team.workers().map((worker) => worker.id)).toEqual(["lead"])
  })

  test("a missing CLI is reported, not thrown", async () => {
    const ctx = setup(["lead", "a"], { isAvailable: () => false })
    ctx.team.sendToOrchestrator("goal")
    await settle()
    expect(entries(ctx.state(), "lead").join()).toContain("not found in PATH")
    expect(ctx.state().board.phase).toBe("idle")
  })

  test("notifications are batched", async () => {
    const ctx = setup(["lead", "a"])
    let count = 0
    ctx.team.subscribe(() => count++)
    ctx.team.sendToRoom("one")
    ctx.team.sendToRoom("two")
    expect(count).toBe(0)
    await Bun.sleep(60)
    expect(count).toBe(1)
  })
})
