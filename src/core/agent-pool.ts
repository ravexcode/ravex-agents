import type { Agent } from "../agents/types.ts"
import { runTurn, type RunTurn, type TurnStatus } from "../providers/runner.ts"
import type { PermissionMode, Provider, ProviderEvent, ProviderId } from "../providers/types.ts"

export type PaneStatus = "idle" | "running" | "done" | "failed" | "cancelled"
export type EntryKind = "user" | "assistant" | "tool" | "error" | "info"

export interface Entry {
  id: number
  kind: EntryKind
  text: string
  /** The task this was part of, so a task's detail can show its conversation. */
  taskId?: number
  /** Part of a room turn, which belongs in the room rather than in the orchestrator's chat. */
  room?: boolean
}

export interface Pane {
  id: string
  label: string
  provider: ProviderId
  model?: string
  available: boolean
  status: PaneStatus
  entries: Entry[]
}

export interface TurnOptions {
  prompt: string
  /** What to show in the agent's conversation for this prompt. */
  display?: string
  /** Turns that share a key continue one conversation. Null starts clean each time. */
  sessionKey: string | null
  mode: PermissionMode
  instructions?: string
  taskId?: number
  room?: boolean
  signal?: AbortSignal
}

export interface TurnOutcome {
  status: TurnStatus
  output: string
  textEntryId?: number
}

export type SavedSessions = Record<string, Record<string, string>>

interface Runtime {
  sessions: Map<string, string>
  pendingSessionId?: string
  textOpen: boolean
  lastTextEntryId?: number
  currentTaskId?: number
  currentRoom?: boolean
  controllers: Set<AbortController>
  pendingTurns: number
  /** Resolves once the last queued turn finishes, so that turns run one at a time. */
  tail: Promise<void>
}

/** A definition change that a resumed conversation wouldn't pick up. */
function conversationKey(agent: Agent): string {
  return JSON.stringify([agent.provider, agent.model, agent.instructions, agent.tools, agent.skills])
}

function waitOrAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
    void promise.then(resolve)
  })
}

export interface AgentPoolOptions {
  cwd: string
  run?: RunTurn
  isAvailable?: (provider: Provider) => boolean
}

/** Runs turns for agents, one at a time per agent, and keeps their conversations. */
export class AgentPool {
  readonly #providers: Map<ProviderId, Provider>
  readonly #runtimes = new Map<string, Runtime>()
  readonly #cwd: string
  readonly #run: RunTurn
  readonly #isAvailable: (provider: Provider) => boolean
  readonly #onChange: () => void
  #agents: Agent[] = []
  #panes: Pane[] = []
  #nextEntryId = 1

  constructor(providers: Provider[], options: AgentPoolOptions, onChange: () => void) {
    this.#providers = new Map(providers.map((provider) => [provider.id, provider]))
    this.#cwd = options.cwd
    this.#run = options.run ?? runTurn
    this.#isAvailable =
      options.isAvailable ?? ((provider: Provider) => Bun.which(provider.binary) !== null)
    this.#onChange = onChange
  }

  get panes(): Pane[] {
    return this.#panes
  }

  isAvailable(agent: Agent): boolean {
    const provider = this.#providers.get(agent.provider)
    return provider ? this.#isAvailable(provider) : false
  }

  isBusy(id: string): boolean {
    return (this.#runtimes.get(id)?.pendingTurns ?? 0) > 0
  }

  /** Keeps existing conversations, except for agents whose definition changed. */
  setAgents(agents: Agent[]): void {
    const previous = new Map(this.#agents.map((agent) => [agent.id, agent]))
    const panes = new Map(this.#panes.map((pane) => [pane.id, pane]))

    this.#panes = agents.map((agent): Pane => {
      const pane = panes.get(agent.id)
      const before = previous.get(agent.id)
      let entries = pane?.entries ?? []

      const runtime = this.#runtimes.get(agent.id)
      if (!runtime) {
        this.#runtimes.set(agent.id, {
          sessions: new Map(),
          textOpen: false,
          controllers: new Set(),
          pendingTurns: 0,
          tail: Promise.resolve(),
        })
      } else if (before && conversationKey(before) !== conversationKey(agent) && runtime.sessions.size > 0) {
        runtime.sessions.clear()
        entries = [
          ...entries,
          { id: this.#nextEntryId++, kind: "info", text: "Agent changed. Starting a new conversation." },
        ]
      }

      return {
        id: agent.id,
        label: agent.name,
        provider: agent.provider,
        ...(agent.model ? { model: agent.model } : {}),
        available: this.isAvailable(agent),
        status: pane?.status ?? "idle",
        entries,
      }
    })

    const ids = new Set(agents.map((agent) => agent.id))
    for (const id of this.#runtimes.keys()) {
      if (!ids.has(id)) this.#runtimes.delete(id)
    }
    this.#agents = agents
    this.#onChange()
  }

  cancel(id: string): void {
    for (const controller of this.#runtimes.get(id)?.controllers ?? []) controller.abort()
  }

  cancelAll(): void {
    for (const id of this.#runtimes.keys()) this.cancel(id)
  }

  async turn(agentId: string, options: TurnOptions): Promise<TurnOutcome> {
    const agent = this.#agents.find((candidate) => candidate.id === agentId)
    const runtime = this.#runtimes.get(agentId)
    const provider = agent && this.#providers.get(agent.provider)
    if (!agent || !runtime || !provider) return { status: "failed", output: `Unknown agent "${agentId}".` }

    if (options.display) this.addEntry(agentId, "user", options.display, options.taskId, options.room)

    if (!this.#isAvailable(provider)) {
      const output = `${provider.binary} was not found in PATH`
      this.addEntry(agentId, "error", output, options.taskId, options.room)
      this.#setStatus(agentId, "failed")
      return { status: "failed", output }
    }

    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal

    const previous = runtime.tail
    let release!: () => void
    const finished = new Promise<void>((resolve) => {
      release = resolve
    })
    runtime.tail = previous.then(() => finished)
    runtime.controllers.add(controller)
    runtime.pendingTurns++

    try {
      await waitOrAbort(previous, signal)
      if (signal.aborted) {
        this.addEntry(agentId, "info", "Cancelado", options.taskId, options.room)
        if (runtime.pendingTurns === 1) this.#setStatus(agentId, "cancelled")
        return { status: "cancelled", output: "" }
      }
      return await this.#execute(agent, provider, runtime, options, signal)
    } finally {
      runtime.controllers.delete(controller)
      runtime.pendingTurns--
      release()
    }
  }

  async #execute(
    agent: Agent,
    provider: Provider,
    runtime: Runtime,
    options: TurnOptions,
    signal: AbortSignal,
  ): Promise<TurnOutcome> {
    runtime.pendingSessionId = undefined
    runtime.textOpen = false
    runtime.lastTextEntryId = undefined
    runtime.currentTaskId = options.taskId
    runtime.currentRoom = options.room
    this.#setStatus(agent.id, "running")
    const firstEntryId = this.#nextEntryId

    const result = await this.#run(
      provider,
      {
        prompt: options.prompt,
        cwd: this.#cwd,
        mode: options.mode,
        sessionId: options.sessionKey ? runtime.sessions.get(options.sessionKey) : undefined,
        model: agent.model,
        instructions: options.instructions || undefined,
        tools: agent.tools,
        nativeSkills: agent.skills === undefined,
      },
      (event) => this.#handleEvent(agent.id, runtime, event),
      signal,
    ).catch((error: unknown) => ({ status: "failed" as const, message: String(error) }))

    runtime.textOpen = false
    if (result.message) this.addEntry(agent.id, "error", result.message, options.taskId, options.room)
    if (result.status === "cancelled") this.addEntry(agent.id, "info", "Cancelado", options.taskId, options.room)

    // A session that never finished a turn may not be resumable, as when
    // authentication fails right after the session starts.
    if (result.status === "done" && options.sessionKey && runtime.pendingSessionId) {
      runtime.sessions.set(options.sessionKey, runtime.pendingSessionId)
    }

    const entries = this.#pane(agent.id)?.entries ?? []
    const textEntryId = runtime.lastTextEntryId
    const lastError = entries.findLast((entry) => entry.kind === "error" && entry.id >= firstEntryId)
    const text = entries.find((entry) => entry.id === textEntryId)?.text ?? ""
    this.#setStatus(agent.id, result.status)

    return {
      status: result.status,
      output: result.status === "failed" ? (result.message ?? lastError?.text ?? text) : text,
      ...(textEntryId !== undefined ? { textEntryId } : {}),
    }
  }

  #handleEvent(id: string, runtime: Runtime, event: ProviderEvent): void {
    const taskId = runtime.currentTaskId
    const room = runtime.currentRoom
    switch (event.type) {
      case "session":
        runtime.pendingSessionId = event.sessionId
        break
      case "text-start":
        runtime.textOpen = false
        break
      case "text-delta":
        if (runtime.textOpen) {
          this.#appendToEntry(id, runtime.lastTextEntryId, event.text)
        } else if (event.text) {
          runtime.textOpen = true
          runtime.lastTextEntryId = this.addEntry(id, "assistant", event.text, taskId, room)
        }
        break
      case "tool":
        runtime.textOpen = false
        this.addEntry(id, "tool", event.detail ? `${event.name}: ${event.detail}` : event.name, taskId, room)
        break
      case "error": {
        runtime.textOpen = false
        // Codex reports the same failure through both `error` and `turn.failed`.
        const last = this.#pane(id)?.entries.at(-1)
        if (last?.kind !== "error" || last.text !== event.message) {
          this.addEntry(id, "error", event.message, taskId, room)
        }
        break
      }
    }
  }

  #pane(id: string): Pane | undefined {
    return this.#panes.find((pane) => pane.id === id)
  }

  #setStatus(id: string, status: PaneStatus): void {
    this.#updatePane(id, (pane) => ({ ...pane, status }))
  }

  addEntry(id: string, kind: EntryKind, text: string, taskId?: number, room?: boolean): number {
    const entry: Entry = {
      id: this.#nextEntryId++,
      kind,
      text,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(room ? { room } : {}),
    }
    this.#updatePane(id, (pane) => ({ ...pane, entries: [...pane.entries, entry] }))
    return entry.id
  }

  /** Removes the entry if there's no text left. */
  replaceText(id: string, entryId: number | undefined, text: string): void {
    this.#updatePane(id, (pane) => ({
      ...pane,
      entries: pane.entries.flatMap((entry) => {
        if (entry.id !== entryId) return [entry]
        return text ? [{ ...entry, text }] : []
      }),
    }))
  }

  /** Targets an ID because another entry can be added during a stream. */
  #appendToEntry(id: string, entryId: number | undefined, text: string): void {
    this.#updatePane(id, (pane) => ({
      ...pane,
      entries: pane.entries.map((entry) =>
        entry.id === entryId ? { ...entry, text: entry.text + text } : entry,
      ),
    }))
  }

  #updatePane(id: string, update: (pane: Pane) => Pane): void {
    this.#panes = this.#panes.map((pane) => (pane.id === id ? update(pane) : pane))
    this.#onChange()
  }

  exportSessions(): SavedSessions {
    const saved: SavedSessions = {}
    for (const [id, runtime] of this.#runtimes) {
      if (runtime.sessions.size > 0) saved[id] = Object.fromEntries(runtime.sessions)
    }
    return saved
  }

  /** Restores saved conversations for agents that still exist. */
  restore(sessions: SavedSessions, entries: Record<string, Entry[]>): void {
    let highest = 0
    this.#panes = this.#panes.map((pane) => {
      const restored = entries[pane.id] ?? []
      for (const entry of restored) highest = Math.max(highest, entry.id)
      const status: PaneStatus = restored.length ? "idle" : pane.status
      return { ...pane, entries: restored, status }
    })
    this.#nextEntryId = Math.max(this.#nextEntryId, highest + 1)
    for (const [id, saved] of Object.entries(sessions)) {
      const runtime = this.#runtimes.get(id)
      if (runtime) runtime.sessions = new Map(Object.entries(saved))
    }
    this.#onChange()
  }
}
