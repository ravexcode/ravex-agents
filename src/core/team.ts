import type { SkillInstructions } from "../agents/skills.ts"
import type { Agent } from "../agents/types.ts"
import type { RunTurn } from "../providers/runner.ts"
import type { PermissionMode, Provider, ProviderId } from "../providers/types.ts"
import { AgentPool, type Entry, type Pane } from "./agent-pool.ts"
import type { ArchivedConversation, ConversationArchive } from "./archive.ts"
import { parseBlock, truncateResult } from "./blocks.ts"
import {
  buildIssuePrompt,
  buildOrchestratorInstructions,
  buildPlanErrorPrompt,
  buildReviewPrompt,
  buildReviewerInstructions,
  buildRoomInstructions,
  buildRunningChatPrompt,
  buildTaskPrompt,
  buildUserReplyPrompt,
  buildWorkerInstructions,
  buildWrapUpPrompt,
  EMPTY_BOARD,
  hasUnresolved,
  MAX_REPLANS,
  MAX_REVIEW_ROUNDS,
  nextRuns,
  parsePlan,
  parseReview,
  parseWorkerReport,
  recoverBoard,
  reportResult,
  type Board,
  type Task,
  type TaskRun,
} from "./board.ts"
import type { StatePersistence, TeamSnapshot } from "./persistence.ts"
import {
  buildRoomPrompt,
  formatRoomContext,
  MAX_ROOM_REPLIES,
  parseMentions,
  stripOwnPrefix,
  type RoomMessage,
} from "./room.ts"

// Terminals can't show more than this anyway, and streams emit far faster.
const NOTIFY_BATCH_MS = 33
const PERSIST_DELAY_MS = 500
const MAX_SAVED_ENTRIES = 500
const MAX_SAVED_ROOM_MESSAGES = 500
const TASK_ROOM_CONTEXT = 10
const ORCHESTRATOR_SESSION = "orchestrator"
const DIRECT_SESSION = "direct"

export interface TeamState {
  mode: PermissionMode
  agents: Agent[]
  orchestratorId: string
  panes: Pane[]
  board: Board
  room: RoomMessage[]
  /** The agent replying in the room right now. */
  roomBusy?: string
  saveError?: string
}

const UNTITLED = "Untitled conversation"

export interface TeamOptions {
  cwd?: string
  run?: RunTurn
  isAvailable?: (provider: Provider) => boolean
  persistence?: StatePersistence
  snapshot?: TeamSnapshot
  /** Where /new and /resume keep conversations. Without it, /new forgets them. */
  archive?: ConversationArchive
  /** Turns skill names into instructions. Agents get no skills without it. */
  resolveSkills?: (names: string[], provider?: ProviderId) => SkillInstructions
}

export function lowerMode(...modes: PermissionMode[]): PermissionMode {
  return modes.includes("read-only") ? "read-only" : "edit"
}

/** Tasks meant to change files that the current permissions would keep read-only. */
export function tasksLimitedByMode(state: TeamState): Task[] {
  const { board } = state
  return board.tasks.filter((task) => {
    const pending =
      task.status === "proposed" || task.status === "todo" || board.pendingRetry.includes(task.id)
    if (!pending || !task.edits) return false
    const agent = state.agents.find((candidate) => candidate.id === task.assignee)
    return lowerMode(state.mode, agent?.mode ?? "read-only") === "read-only"
  })
}

export function permissionWarning(state: TeamState): string | undefined {
  const limited = tasksLimitedByMode(state).length
  return limited > 0
    ? `${state.board.phase === "proposed" ? "Approving" : "Continuing"} doesn't grant permissions: ${limited} editing ${limited === 1 ? "task" : "tasks"} would run read-only (^E, and the agent's tools).`
    : undefined
}

interface PlanTurn {
  prompt: string
  display?: string
  /** Set when this message starts a new goal, should it produce a plan. */
  newGoal?: string
}

/** Coordinates the team: the orchestrator's plans, the board and the room. */
export class Team {
  readonly #pool: AgentPool
  readonly #persistence?: StatePersistence
  readonly #archive?: ConversationArchive
  readonly #resolveSkills?: (names: string[], provider?: ProviderId) => SkillInstructions
  readonly #listeners = new Set<() => void>()
  readonly #active = new Map<number, string>()
  #state: TeamState
  #notifyTimer: ReturnType<typeof setTimeout> | undefined
  #persistTimer: ReturnType<typeof setTimeout> | undefined
  #runController = new AbortController()
  #roomController = new AbortController()
  #roomTail: Promise<void> = Promise.resolve()
  #nextRoomId = 1
  #userStopped = false
  #stopped = false
  #directEdits = 0

  constructor(providers: Provider[], agents: Agent[], orchestratorId: string, options: TeamOptions = {}) {
    this.#persistence = options.persistence
    this.#archive = options.archive
    this.#resolveSkills = options.resolveSkills
    const { snapshot } = options
    this.#state = {
      mode: "read-only",
      agents,
      orchestratorId,
      panes: [],
      board: snapshot ? recoverBoard(snapshot.board) : EMPTY_BOARD,
      room: snapshot?.room ?? [],
    }
    this.#nextRoomId = Math.max(0, ...(snapshot?.room ?? []).map((message) => message.id)) + 1
    this.#pool = new AgentPool(
      providers,
      { cwd: options.cwd ?? process.cwd(), run: options.run, isAvailable: options.isAvailable },
      () => this.#syncPanes(),
    )
    this.#pool.setAgents(agents)
    if (snapshot) this.#pool.restore(snapshot.sessions, snapshot.entries)
  }

  getState = (): TeamState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Everyone who can take tasks right now. */
  workers(): Agent[] {
    const { agents, orchestratorId } = this.#state
    return agents.filter((agent) => agent.id !== orchestratorId && this.#pool.isAvailable(agent))
  }

  isBusy(id: string): boolean {
    return this.#pool.isBusy(id) || [...this.#active.values()].includes(id)
  }

  setTeam(agents: Agent[], orchestratorId: string): void {
    this.#setState({ agents, orchestratorId })
    this.#pool.setAgents(agents)
  }

  toggleMode(): void {
    this.#setState({ mode: this.#state.mode === "read-only" ? "edit" : "read-only" })
  }

  // The orchestrator

  /** Returns a notice if the message can't be handled right now. */
  sendToOrchestrator(text: string, shown = text): string | undefined {
    const message = text.trim()
    const display = shown.trim()
    if (!message) return undefined
    const { board } = this.#state

    switch (board.phase) {
      case "planning":
      case "wrapping-up":
        return "The orchestrator is working. Press Esc to cancel it."
      case "running":
        void this.#chatDuringRun(message, display)
        return undefined
      case "idle":
        void this.#planTurn({ prompt: message, display, newGoal: display })
        return undefined
      case "proposed":
      case "paused": {
        if (board.replans >= MAX_REPLANS) {
          return board.phase === "proposed"
            ? `Reached the limit of ${MAX_REPLANS} replans: approve or discard this plan.`
            : `Reached the limit of ${MAX_REPLANS} replans: press Esc to close the goal.`
        }
        if (board.phase === "paused") this.#commentOnBlocked(display)
        const prompt =
          board.phase === "proposed"
            ? `Change the proposed plan: ${message}\n\nSend the complete new plan.`
            : buildUserReplyPrompt(message, this.#state.board)
        void this.#planTurn({ prompt, display })
        return undefined
      }
    }
  }

  #commentOnBlocked(text: string): void {
    this.#setBoard({
      tasks: this.#state.board.tasks.map((task) =>
        task.status === "blocked"
          ? { ...task, comments: [...task.comments, { author: "you", text }] }
          : task,
      ),
    })
  }

  #orchestrator(): Agent | undefined {
    return this.#agent(this.#state.orchestratorId)
  }

  #orchestratorInstructions(): string {
    const roster = this.workers().map((agent) => ({
      id: agent.id,
      description: agent.description,
      engine: agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
      tools: describeTools(agent),
      skills: agent.skills ?? [],
    }))
    return buildOrchestratorInstructions(this.#ownInstructions(this.#orchestrator()), roster)
  }

  /** The agent's instructions with its skills. Read each turn, so edits to a skill apply right away. */
  #ownInstructions(agent: Agent | undefined): string {
    if (!agent) return ""
    if (!agent.skills?.length || !this.#resolveSkills) return agent.instructions

    const { text, missing } = this.#resolveSkills(agent.skills, agent.provider)
    if (missing.length > 0) {
      this.#pool.addEntry(agent.id, "error", `Skills not found: ${missing.join(", ")}`)
    }
    return [agent.instructions, text].filter(Boolean).join("\n\n")
  }

  async #planTurn({ prompt, display, newGoal }: PlanTurn): Promise<void> {
    const id = this.#state.orchestratorId
    this.#setBoard({ phase: "planning" })

    let outcome = await this.#pool.turn(id, {
      prompt,
      display,
      sessionKey: ORCHESTRATOR_SESSION,
      // It only plans, so it never needs to change anything.
      mode: "read-only",
      instructions: this.#orchestratorInstructions(),
    })
    if (this.#stopped) return

    // A malformed plan is worth one automatic correction, but not a loop.
    for (let attempt = 0; outcome.status === "done"; attempt++) {
      const base = newGoal ? { ...EMPTY_BOARD, nextTaskId: this.#state.board.nextTaskId } : this.#withoutProposal()
      const workers = this.workers()
      const plan = parsePlan(outcome.output, {
        workers: new Set(workers.map((agent) => agent.id)),
        editors: new Set(workers.filter((agent) => agent.mode === "edit").map((agent) => agent.id)),
        board: base,
      })
      if (!plan) break

      this.#pool.replaceText(id, outcome.textEntryId, plan.text)
      if (!plan.error) {
        this.#setBoard({
          ...base,
          goal: newGoal ?? base.goal,
          phase: "proposed",
          tasks: [...base.tasks, ...plan.tasks],
          pendingRetry: plan.retry,
          replans: newGoal ? 0 : base.replans + 1,
          nextTaskId: base.nextTaskId + plan.tasks.length,
        })
        const count = plan.tasks.length + plan.retry.length
        this.#pool.addEntry(
          id,
          "info",
          `Proposed ${count} ${count === 1 ? "task" : "tasks"}. Nothing runs until you approve. Enter approves, typing changes the plan, Esc discards it.`,
        )
        return
      }

      this.#pool.addEntry(id, "error", `Invalid plan: ${plan.error}`)
      if (attempt > 0) break
      outcome = await this.#pool.turn(id, {
        prompt: buildPlanErrorPrompt(plan.error),
        sessionKey: ORCHESTRATOR_SESSION,
        mode: "read-only",
        instructions: this.#orchestratorInstructions(),
      })
      if (this.#stopped) return
    }

    this.#setBoard({ phase: this.#restingPhase() })
  }

  /** A new plan replaces the proposal it was asked to change. */
  #withoutProposal(): Board {
    const { board } = this.#state
    const proposed = board.tasks.filter((task) => task.status === "proposed").map((task) => task.id)
    return {
      ...board,
      tasks: board.tasks.filter((task) => task.status !== "proposed"),
      pendingRetry: [],
      nextTaskId: proposed.length ? Math.min(...proposed) : board.nextTaskId,
    }
  }

  #restingPhase(): Board["phase"] {
    const { tasks, pendingRetry } = this.#state.board
    if (pendingRetry.length > 0 || tasks.some((task) => task.status === "proposed")) return "proposed"
    return hasUnresolved(tasks) || tasks.some((task) => task.status === "review") ? "paused" : "idle"
  }

  async #chatDuringRun(message: string, display: string): Promise<void> {
    const id = this.#state.orchestratorId
    const outcome = await this.#pool.turn(id, {
      prompt: buildRunningChatPrompt(message, this.#state.board),
      display,
      sessionKey: ORCHESTRATOR_SESSION,
      mode: "read-only",
      instructions: this.#orchestratorInstructions(),
    })
    if (outcome.status === "done") this.#stripPlan(id, outcome.output, outcome.textEntryId)
  }

  /** Removes a plan that arrived when one can't be accepted. */
  #stripPlan(id: string, output: string, entryId: number | undefined): void {
    const block = parseBlock(output, "ravex-plan")
    if (!block) return
    this.#pool.replaceText(id, entryId, block.text)
    this.#pool.addEntry(id, "info", "Plan ignored: plans aren't accepted right now.")
  }

  /** Returns a warning if some of the work won't have the permissions it expects. */
  approve(): string | undefined {
    const { board } = this.#state
    if (board.phase !== "proposed") return "There's no proposed plan."
    const warning = permissionWarning(this.#state)

    this.#setBoard({
      phase: "running",
      pendingRetry: [],
      tasks: board.tasks.map((task): Task => {
        if (task.status === "proposed") return { ...task, status: "todo" }
        if (board.pendingRetry.includes(task.id)) {
          const { result: _result, ...rest } = task
          return { ...rest, status: "todo", reviewRounds: 0 }
        }
        // The plan decides what happens next, so whatever it left out is over.
        const leftOut = ["todo", "blocked", "failed"].includes(task.status)
        return leftOut ? { ...task, status: "cancelled" } : task
      }),
    })
    this.#pool.addEntry(this.#state.orchestratorId, "info", "Plan approved.")
    this.#beginRun()
    return warning
  }

  discardPlan(): void {
    const { board } = this.#state
    if (board.phase !== "proposed") return
    this.#setBoard(this.#withoutProposal())
    this.#setBoard({ phase: this.#restingPhase() })
    this.#pool.addEntry(this.#state.orchestratorId, "info", "Plan discarded.")
  }

  /** Continues paused work that can still run. Returns a notice if there's none. */
  resume(): string | undefined {
    const { board } = this.#state
    if (board.phase !== "paused") return undefined
    if (nextRuns(board.tasks, this.#active, this.#directEdits > 0).length === 0) {
      return "No tasks are ready to continue. Type what to do, or press Esc to close the goal."
    }
    const warning = permissionWarning(this.#state)
    this.#setBoard({ phase: "running" })
    this.#beginRun()
    return warning
  }

  #beginRun(): void {
    this.#userStopped = false
    this.#runController = new AbortController()
    this.#dispatch()
  }

  /** Marks whatever is left as cancelled and leaves the goal behind. */
  closeGoal(): void {
    const { board } = this.#state
    if (board.phase !== "paused") return
    this.#setBoard({
      phase: "idle",
      tasks: board.tasks.map((task) =>
        ["todo", "blocked", "failed", "review"].includes(task.status)
          ? { ...task, status: "cancelled" as const }
          : task,
      ),
    })
    this.#pool.addEntry(this.#state.orchestratorId, "info", "Goal closed.")
  }

  /** Stops the running tasks. Unstarted ones stay, so work can continue later. */
  stopWork(): void {
    this.#userStopped = true
    this.#runController.abort()
  }

  cancelAgent(id: string): void {
    if ([...this.#active.values()].includes(id)) this.#userStopped = true
    this.#pool.cancel(id)
  }

  /** Returns a notice if it can't be reassigned. */
  reassign(taskId: number, agentId: string): string | undefined {
    const task = this.#state.board.tasks.find((candidate) => candidate.id === taskId)
    if (!task) return "That task doesn't exist."
    if (!["proposed", "todo", "blocked", "failed", "cancelled"].includes(task.status)) {
      return "Only tasks that aren't running or finished can be reassigned."
    }
    if (!this.workers().some((agent) => agent.id === agentId)) {
      return `"${agentId}" isn't available on the team.`
    }
    this.#updateTask(taskId, ({ reviewer, ...rest }) => ({
      ...rest,
      assignee: agentId,
      // Nobody reviews their own work.
      ...(reviewer && reviewer !== agentId ? { reviewer } : {}),
    }))
    return undefined
  }

  comment(taskId: number, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.#addComment(taskId, "you", trimmed)
  }

  #addComment(taskId: number, author: string, text: string): void {
    this.#updateTask(taskId, (task) => ({ ...task, comments: [...task.comments, { author, text }] }))
  }

  // The dispatcher

  #dispatch(): void {
    if (this.#stopped || this.#state.board.phase !== "running") return
    // After a stop, what's left waits for the user, instead of starting and being cancelled.
    const runs = this.#runController.signal.aborted
      ? []
      : nextRuns(this.#state.board.tasks, this.#active, this.#directEdits > 0)
    for (const run of runs) {
      this.#active.set(run.task.id, run.agent)
      if (run.kind === "work") this.#updateTask(run.task.id, (task) => ({ ...task, status: "running" }))
      const verb = run.kind === "work" ? "started" : "is reviewing"
      this.#roomEvent(`${this.#nameOf(run.agent)} ${verb} task ${run.task.id}: ${run.task.title}`)
      void this.#runTask(run)
    }
    if (this.#active.size === 0 && this.#directEdits === 0) this.#onIdle()
  }

  #onIdle(): void {
    const { tasks, replans } = this.#state.board
    const orchestratorId = this.#state.orchestratorId

    if (this.#userStopped) {
      this.#setBoard({ phase: "paused" })
      this.#pool.addEntry(orchestratorId, "info", "Work stopped. Enter continues, type what to do, or Esc closes the goal.")
    } else if (tasks.every((task) => task.status === "done" || task.status === "cancelled")) {
      void this.#wrapUp()
    } else if (replans >= MAX_REPLANS) {
      this.#setBoard({ phase: "paused" })
      this.#pool.addEntry(orchestratorId, "error", `Some tasks are unfinished and the limit of ${MAX_REPLANS} replans was reached. Press Esc to close the goal.`)
    } else {
      void this.#planTurn({ prompt: buildIssuePrompt(this.#state.board) })
    }
  }

  async #wrapUp(): Promise<void> {
    const id = this.#state.orchestratorId
    this.#setBoard({ phase: "wrapping-up" })
    this.#pool.addEntry(id, "info", "All tasks finished.")
    const outcome = await this.#pool.turn(id, {
      prompt: buildWrapUpPrompt(this.#state.board),
      sessionKey: ORCHESTRATOR_SESSION,
      mode: "read-only",
      instructions: this.#orchestratorInstructions(),
    })
    if (this.#stopped) return
    if (outcome.status === "done") this.#stripPlan(id, outcome.output, outcome.textEntryId)
    this.#setBoard({ phase: "idle" })
  }

  async #runTask(run: TaskRun): Promise<void> {
    if (run.kind === "work") await this.#work(run.task, run.agent)
    else await this.#review(run.task, run.agent)
    this.#active.delete(run.task.id)
    if (this.#stopped) return
    this.#dispatch()
  }

  async #work(task: Task, agentId: string): Promise<void> {
    const agent = this.#agent(agentId)
    const mode = task.edits ? lowerMode(this.#state.mode, agent?.mode ?? "read-only") : "read-only"
    const outcome = await this.#pool.turn(agentId, {
      prompt: buildTaskPrompt(task, this.#state.board, formatRoomContext(this.#state.room, TASK_ROOM_CONTEXT)),
      display: `Task ${task.id}: ${task.title}`,
      sessionKey: `task:${task.id}`,
      mode,
      instructions: buildWorkerInstructions(this.#ownInstructions(agent), mode === "edit"),
      taskId: task.id,
      signal: this.#runController.signal,
    })
    // On quitting, the task stays "running" so that it comes back as interrupted.
    if (this.#stopped) return

    if (outcome.status === "cancelled") {
      this.#updateTask(task.id, (current) => ({ ...current, status: "cancelled" }))
      this.#roomEvent(`Task ${task.id} cancelled`)
      return
    }
    if (outcome.status === "failed") {
      this.#updateTask(task.id, (current) => ({ ...current, status: "failed", result: truncateResult(outcome.output) }))
      this.#roomEvent(`Task ${task.id} failed: ${firstLine(outcome.output)}`)
      return
    }

    const report = parseWorkerReport(outcome.output)
    this.#pool.replaceText(agentId, outcome.textEntryId, report.text)
    if (report.comment) this.#addComment(task.id, agentId, report.comment)
    if (report.room) this.#postFromAgent(agentId, report.room)
    const result = truncateResult(reportResult(report))

    if (report.status === "blocked") {
      this.#updateTask(task.id, (current) => ({ ...current, status: "blocked", result }))
      this.#roomEvent(`Task ${task.id} blocked: ${firstLine(report.summary)}`)
      this.#pool.addEntry(this.#state.orchestratorId, "info", `Task ${task.id} blocked (${this.#nameOf(agentId)}): ${report.summary}`)
      return
    }

    const reviewer = task.reviewer ?? (report.status === "review" ? this.#state.orchestratorId : undefined)
    if (reviewer) {
      this.#updateTask(task.id, (current) => ({ ...current, status: "review", reviewer, result }))
      return
    }
    this.#updateTask(task.id, (current) => ({ ...current, status: "done", result }))
    this.#roomEvent(`Task ${task.id} finished by ${this.#nameOf(agentId)}`)
  }

  async #review(task: Task, reviewerId: string): Promise<void> {
    const agent = this.#agent(reviewerId)
    const outcome = await this.#pool.turn(reviewerId, {
      prompt: buildReviewPrompt(task),
      display: `Review of task ${task.id}: ${task.title}`,
      sessionKey: `review:${task.id}`,
      mode: "read-only",
      instructions: buildReviewerInstructions(this.#ownInstructions(agent)),
      taskId: task.id,
      signal: this.#runController.signal,
    })
    if (this.#stopped) return

    if (outcome.status === "cancelled") {
      this.#updateTask(task.id, (current) => ({ ...current, status: "cancelled" }))
      return
    }
    if (outcome.status === "failed") {
      this.#addComment(task.id, reviewerId, `The review failed: ${outcome.output}`)
      this.#updateTask(task.id, (current) => ({ ...current, status: "blocked" }))
      this.#roomEvent(`The review of task ${task.id} failed`)
      return
    }

    const review = parseReview(outcome.output)
    this.#pool.replaceText(reviewerId, outcome.textEntryId, review.text)
    if (review.comment) this.#addComment(task.id, reviewerId, review.comment)

    if (review.verdict === "approved") {
      this.#updateTask(task.id, (current) => ({ ...current, status: "done" }))
      this.#roomEvent(`${this.#nameOf(reviewerId)} approved task ${task.id}`)
    } else if (review.verdict === "none") {
      this.#updateTask(task.id, (current) => ({ ...current, status: "blocked" }))
      this.#roomEvent(`The review of task ${task.id} gave no verdict`)
    } else if (task.reviewRounds >= MAX_REVIEW_ROUNDS) {
      this.#updateTask(task.id, (current) => ({ ...current, status: "blocked" }))
      this.#roomEvent(`Task ${task.id} blocked: still needs changes after ${MAX_REVIEW_ROUNDS} review rounds`)
    } else {
      this.#updateTask(task.id, (current) => ({ ...current, status: "todo", reviewRounds: current.reviewRounds + 1 }))
      this.#roomEvent(`${this.#nameOf(reviewerId)} asked for changes on task ${task.id}`)
    }
  }

  // Talking to one agent

  sendToAgent(id: string, text: string, shown = text): string | undefined {
    const message = text.trim()
    if (!message) return undefined
    const agent = this.#agent(id)
    if (!agent) return "That agent doesn't exist."
    void this.#directTurn(agent, message, shown.trim())
    return undefined
  }

  /** The prompt that makes an agent use a skill for this request. Undefined if the skill can't be found. */
  skillPrompt(name: string, request: string, agentId: string): string | undefined {
    const resolved = this.#resolveSkills?.([name], this.#agent(agentId)?.provider)
    if (!resolved?.text) return undefined
    const ask = request ? `Follow it for this request:\n\n${request}` : "Follow it now."
    return `${resolved.text}\n\nThe user chose the skill above with /${name}. ${ask}`
  }

  async #directTurn(agent: Agent, message: string, display: string): Promise<void> {
    const { board } = this.#state
    const editing =
      this.#directEdits > 0 || board.tasks.some((task) => task.status === "running" && task.edits)
    const allowed = lowerMode(this.#state.mode, agent.mode)
    // Everyone shares one folder, so this waits for no one but can't edit alongside anyone.
    const mode = editing ? "read-only" : allowed
    if (editing && allowed === "edit") {
      this.#pool.addEntry(agent.id, "info", "Another agent is editing, so this turn runs read-only.")
    }

    if (mode === "edit") this.#directEdits++
    await this.#pool.turn(agent.id, {
      prompt: message,
      display,
      sessionKey: DIRECT_SESSION,
      mode,
      instructions: this.#ownInstructions(agent),
    })
    if (mode === "edit") {
      this.#directEdits--
      this.#dispatch()
    }
  }

  // The room

  /** Returns a notice if nobody will reply. */
  sendToRoom(text: string): string | undefined {
    const message = text.trim()
    if (!message) return undefined
    this.#addRoomMessage({ kind: "user", text: message })

    const { known, unknown } = parseMentions(message, new Set(this.#state.agents.map((agent) => agent.id)))
    if (unknown.length > 0) {
      this.#addRoomMessage({ kind: "info", text: `Nobody is called ${unknown.map((id) => `@${id}`).join(", ")}` })
    }
    if (known.length === 0) return "Nobody replies without a mention: use @name to call an agent."
    this.#startRoomChain(known)
    return undefined
  }

  cancelRoom(): void {
    this.#roomController.abort()
    this.#roomController = new AbortController()
  }

  #postFromAgent(agentId: string, text: string): void {
    this.#addRoomMessage({ kind: "agent", author: agentId, text })
    const ids = new Set(this.#state.agents.map((agent) => agent.id))
    const mentioned = parseMentions(text, ids).known.filter((id) => id !== agentId)
    if (mentioned.length > 0) this.#startRoomChain(mentioned)
  }

  /** Replies run one at a time, so each agent sees what the previous one said. */
  #startRoomChain(initial: string[]): void {
    const { signal } = this.#roomController
    this.#roomTail = this.#roomTail.then(() => this.#runRoomChain(initial, signal))
  }

  async #runRoomChain(initial: string[], signal: AbortSignal): Promise<void> {
    const queue = [...initial]
    let replies = 0

    while (queue.length > 0 && !signal.aborted && !this.#stopped) {
      if (replies >= MAX_ROOM_REPLIES) {
        this.#addRoomMessage({ kind: "info", text: `Reached the limit of ${MAX_ROOM_REPLIES} chained replies. Mention someone to continue.` })
        break
      }
      const id = queue.shift() as string
      const agent = this.#agent(id)
      if (!agent) continue

      replies++
      this.#setState({ roomBusy: id })
      const teammates = this.#state.agents.filter((other) => other.id !== id).map((other) => `@${other.id}`)
      const outcome = await this.#pool.turn(id, {
        prompt: buildRoomPrompt(this.#state.room, id),
        display: "Mentioned in the room",
        // The room is the shared memory, so a clean session sees only that.
        sessionKey: null,
        // Changes to files go through tasks, whatever the session's mode is.
        mode: "read-only",
        instructions: buildRoomInstructions(this.#ownInstructions(agent), teammates),
        room: true,
        signal,
      })
      this.#setState({ roomBusy: undefined })
      if (this.#stopped) return

      if (outcome.status === "done") {
        const reply = stripOwnPrefix(outcome.output, id)
        if (!reply) continue
        this.#addRoomMessage({ kind: "agent", author: id, text: reply })
        const ids = new Set(this.#state.agents.map((other) => other.id))
        for (const next of parseMentions(reply, ids).known) {
          if (next !== id && !queue.includes(next)) queue.push(next)
        }
      } else if (outcome.status === "failed") {
        this.#addRoomMessage({ kind: "error", text: `${agent.name} failed: ${firstLine(outcome.output)}` })
      } else {
        this.#addRoomMessage({ kind: "info", text: `${agent.name} cancelled` })
      }
    }
  }

  #roomEvent(text: string): void {
    this.#addRoomMessage({ kind: "info", text })
  }

  #addRoomMessage(message: Omit<RoomMessage, "id">): void {
    this.#setState({ room: [...this.#state.room, { id: this.#nextRoomId++, ...message }] })
  }

  // Conversations

  /** Whether anything is running, which would keep going against the wrong conversation. */
  isWorking(): boolean {
    const { board, panes, roomBusy } = this.#state
    return (
      board.phase === "planning" ||
      board.phase === "running" ||
      board.phase === "wrapping-up" ||
      roomBusy !== undefined ||
      panes.some((pane) => this.#pool.isBusy(pane.id))
    )
  }

  listConversations(): ArchivedConversation[] {
    return this.#archive?.list() ?? []
  }

  /** Returns a notice if it can't start one. The current conversation can be resumed later. */
  startConversation(): string | undefined {
    return this.#switchConversation()
  }

  /** Returns a notice if it can't be resumed. The current conversation can be resumed later. */
  resumeConversation(id: string): string | undefined {
    const snapshot = this.#archive?.load(id)
    if (!snapshot) return "That conversation can't be read anymore."
    const notice = this.#switchConversation(snapshot)
    if (!notice) this.#archive?.remove(id)
    return notice
  }

  #switchConversation(next?: TeamSnapshot): string | undefined {
    if (this.isWorking()) return "Agents are working. Press Esc to cancel them first."
    if (this.#hasConversation()) {
      try {
        this.#archive?.save(this.#title(), this.#snapshot())
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return `Couldn't set this conversation aside, so it's still open: ${reason}`
      }
    }

    const room = next?.room ?? []
    this.#nextRoomId = Math.max(0, ...room.map((message) => message.id)) + 1
    this.#userStopped = false
    this.#setState({ board: next ? recoverBoard(next.board) : EMPTY_BOARD, room })
    this.#pool.restore(next?.sessions ?? {}, next?.entries ?? {})
    this.flush()
    return undefined
  }

  /** Notes such as "Agent changed" aren't worth keeping on their own. */
  #hasConversation(): boolean {
    const { board, panes, room } = this.#state
    return board.tasks.length > 0 || room.length > 0 || panes.some((pane) => pane.entries.some((entry) => entry.kind === "user"))
  }

  /** What the user first said, which is what they'll recognize it by. */
  #title(): string {
    const { board, panes, room } = this.#state
    const first = panes
      .flatMap((pane) => pane.entries)
      .filter((entry) => entry.kind === "user" && !entry.room && entry.taskId === undefined)
      .sort((a, b) => a.id - b.id)[0]
    return first?.text ?? board.goal ?? room.find((message) => message.kind === "user")?.text ?? UNTITLED
  }

  // Shutdown

  /** Stops everything for good. Running tasks are saved as running, then recover as interrupted. */
  stop(): void {
    this.#stopped = true
    this.#runController.abort()
    this.#roomController.abort()
    this.#pool.cancelAll()
    this.flush()
  }

  /** Saves right away instead of waiting for the next scheduled save. */
  flush(): void {
    clearTimeout(this.#persistTimer)
    this.#persistTimer = undefined
    if (!this.#persistence) return

    try {
      this.#persistence.save(this.#snapshot())
      if (this.#state.saveError) this.#setState({ saveError: undefined })
    } catch (error) {
      const saveError = error instanceof Error ? error.message : String(error)
      if (this.#state.saveError !== saveError) this.#state = { ...this.#state, saveError }
    }
  }

  #snapshot(): TeamSnapshot {
    const entries: Record<string, Entry[]> = {}
    for (const pane of this.#state.panes) {
      if (pane.entries.length > 0) entries[pane.id] = pane.entries.slice(-MAX_SAVED_ENTRIES)
    }
    return {
      version: 1,
      board: this.#state.board,
      room: this.#state.room.slice(-MAX_SAVED_ROOM_MESSAGES),
      sessions: this.#pool.exportSessions(),
      entries,
    }
  }

  #agent(id: string): Agent | undefined {
    return this.#state.agents.find((agent) => agent.id === id)
  }

  #nameOf(id: string): string {
    return this.#agent(id)?.name ?? id
  }

  #updateTask(id: number, update: (task: Task) => Task): void {
    this.#setBoard({
      tasks: this.#state.board.tasks.map((task) => (task.id === id ? update(task) : task)),
    })
  }

  #setBoard(changes: Partial<Board>): void {
    this.#setState({ board: { ...this.#state.board, ...changes } })
  }

  #syncPanes(): void {
    this.#setState({ panes: this.#pool.panes })
  }

  #setState(changes: Partial<TeamState>): void {
    this.#state = { ...this.#state, ...changes }
    if (this.#notifyTimer === undefined) {
      this.#notifyTimer = setTimeout(() => {
        this.#notifyTimer = undefined
        for (const listener of this.#listeners) listener()
      }, NOTIFY_BATCH_MS)
    }
    if (this.#persistence && this.#persistTimer === undefined && !this.#stopped) {
      this.#persistTimer = setTimeout(() => this.flush(), PERSIST_DELAY_MS)
      this.#persistTimer.unref?.()
    }
  }
}

function describeTools(agent: Agent): string {
  if (agent.tools) return ["read", ...agent.tools].join(", ")
  return agent.mode === "edit" ? "all" : "read"
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? ""
}
