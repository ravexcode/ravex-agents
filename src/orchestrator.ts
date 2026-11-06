import {
  buildInstructions,
  formatDelegationError,
  formatResults,
  parseDelegation,
  type DelegationResult,
  type DelegationTask,
} from "./agents/delegation.ts"
import { MAX_DELEGATION_DEPTH, rootIds } from "./agents/graph.ts"
import type { Agent } from "./agents/types.ts"
import { truncateDetail } from "./providers/parse.ts"
import { runTurn, type RunTurn, type TurnStatus } from "./providers/runner.ts"
import type { PermissionMode, Provider, ProviderEvent, ProviderId } from "./providers/types.ts"

// Providers can stream many deltas per frame; this caps re-renders at about 30 per second.
const NOTIFY_INTERVAL_MS = 33
const MAX_PARALLEL_SUBAGENTS = 4
const MAX_ROUNDS_PER_CHAIN = 5

export type Target = string
export const ALL_AGENTS: Target = "all"

export type PaneStatus = "idle" | "running" | "waiting" | "done" | "failed" | "cancelled"
export type EntryKind = "user" | "assistant" | "tool" | "error" | "info"

export interface Entry {
  id: number
  kind: EntryKind
  text: string
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

export interface OrchestratorState {
  mode: PermissionMode
  agents: Agent[]
  panes: Pane[]
}

export interface OrchestratorOptions {
  cwd?: string
  run?: RunTurn
  isAvailable?: (provider: Provider) => boolean
}

/** A definition change that a resumed conversation wouldn't pick up. */
function conversationKey(agent: Agent): string {
  return JSON.stringify([agent.provider, agent.model, agent.instructions, agent.subagents])
}

interface Runtime {
  /** Only direct conversations resume; each delegated task starts clean. */
  sessionId?: string
  pendingSessionId?: string
  textOpen: boolean
  lastTextEntryId?: number
  /** Every chain running or queued on this agent. */
  controllers: Set<AbortController>
  pendingChains: number
  /** Resolves once the last queued chain finishes, so that chains run one at a time. */
  tail: Promise<void>
}

interface ChainContext {
  /** Whether to keep the conversation for the next direct prompt. */
  persistent: boolean
  depth: number
  maxMode: PermissionMode
  parentSignal?: AbortSignal
}

interface ChainResult {
  status: TurnStatus
  output: string
}

function lowerMode(...modes: PermissionMode[]): PermissionMode {
  return modes.includes("read-only") ? "read-only" : "edit"
}

function waitOrAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
    void promise.then(resolve)
  })
}

async function mapWithLimit<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const position = next++
      results[position] = await map(items[position] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export class Orchestrator {
  readonly #providers: Map<ProviderId, Provider>
  readonly #runtimes = new Map<string, Runtime>()
  readonly #listeners = new Set<() => void>()
  readonly #cwd: string
  readonly #run: RunTurn
  readonly #isAvailable: (provider: Provider) => boolean
  #state: OrchestratorState
  #nextEntryId = 1
  #notifyTimer: Timer | undefined

  constructor(providers: Provider[], agents: Agent[], options: OrchestratorOptions = {}) {
    this.#providers = new Map(providers.map((provider) => [provider.id, provider]))
    this.#cwd = options.cwd ?? process.cwd()
    this.#run = options.run ?? runTurn
    this.#isAvailable =
      options.isAvailable ?? ((provider: Provider) => Bun.which(provider.binary) !== null)
    this.#state = { mode: "read-only", agents: [], panes: [] }
    this.setAgents(agents)
  }

  getState = (): OrchestratorState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Keeps existing conversations, except for agents whose definition changed. */
  setAgents(agents: Agent[]): void {
    const previous = new Map(this.#state.agents.map((agent) => [agent.id, agent]))
    const panes = new Map(this.#state.panes.map((pane) => [pane.id, pane]))

    const nextPanes = agents.map((agent): Pane => {
      const provider = this.#providers.get(agent.provider)
      const pane = panes.get(agent.id)
      const before = previous.get(agent.id)
      let entries = pane?.entries ?? []

      if (!this.#runtimes.has(agent.id)) {
        this.#runtimes.set(agent.id, {
          textOpen: false,
          controllers: new Set(),
          pendingChains: 0,
          tail: Promise.resolve(),
        })
      } else if (before && conversationKey(before) !== conversationKey(agent)) {
        const runtime = this.#runtimes.get(agent.id)
        if (runtime?.sessionId) {
          runtime.sessionId = undefined
          entries = [
            ...entries,
            { id: this.#nextEntryId++, kind: "info", text: "Agent changed. Starting a new conversation." },
          ]
        }
      }

      return {
        id: agent.id,
        label: agent.name,
        provider: agent.provider,
        model: agent.model,
        available: provider ? this.#isAvailable(provider) : false,
        status: pane?.status ?? "idle",
        entries,
      }
    })

    const ids = new Set(agents.map((agent) => agent.id))
    for (const id of this.#runtimes.keys()) {
      if (!ids.has(id)) this.#runtimes.delete(id)
    }
    this.#setState({ ...this.#state, agents, panes: nextPanes })
  }

  toggleMode(): void {
    this.#setState({
      ...this.#state,
      mode: this.#state.mode === "read-only" ? "edit" : "read-only",
    })
  }

  /** Whether an agent has work running or queued. */
  isBusy(id: string): boolean {
    return (this.#runtimes.get(id)?.pendingChains ?? 0) > 0
  }

  /** Sending to all goes to root agents; subagents are reached through their parents. */
  send(target: Target, prompt: string): void {
    const text = prompt.trim()
    if (!text) return

    const ids = target === ALL_AGENTS ? rootIds(this.#state.agents) : [target]
    for (const id of ids) {
      const agent = this.#agent(id)
      if (!agent) continue
      if (this.isBusy(id)) {
        this.#addEntry(id, "info", "Still running. Press Esc to cancel, then send again.")
        continue
      }
      this.#addEntry(id, "user", text)
      void this.#runChain(agent, text, { persistent: true, depth: 0, maxMode: "edit" })
    }
  }

  /** Cancelling an agent also stops the subagents working for it. */
  cancel(target: Target): void {
    const runtimes =
      target === ALL_AGENTS ? [...this.#runtimes.values()] : [this.#runtimes.get(target)]
    for (const runtime of runtimes) {
      for (const controller of runtime?.controllers ?? []) controller.abort()
    }
  }

  async #runChain(agent: Agent, prompt: string, context: ChainContext): Promise<ChainResult> {
    const runtime = this.#runtimes.get(agent.id)
    const provider = this.#providers.get(agent.provider)
    if (!runtime || !provider) return { status: "failed", output: `Unknown agent "${agent.id}".` }

    if (!this.#isAvailable(provider)) {
      const output = `${provider.binary} was not found in PATH`
      this.#addEntry(agent.id, "error", output)
      return { status: "failed", output }
    }

    const controller = new AbortController()
    const signal = context.parentSignal
      ? AbortSignal.any([controller.signal, context.parentSignal])
      : controller.signal

    const previous = runtime.tail
    let release!: () => void
    const finished = new Promise<void>((resolve) => {
      release = resolve
    })
    runtime.tail = previous.then(() => finished)
    runtime.controllers.add(controller)
    runtime.pendingChains++

    try {
      await waitOrAbort(previous, signal)
      if (signal.aborted) {
        this.#addEntry(agent.id, "info", "Cancelled")
        if (runtime.pendingChains === 1) this.#setStatus(agent.id, "cancelled")
        return { status: "cancelled", output: "" }
      }
      return await this.#runRounds(agent, provider, runtime, prompt, context, signal)
    } finally {
      runtime.controllers.delete(controller)
      runtime.pendingChains--
      release()
    }
  }

  async #runRounds(
    agent: Agent,
    provider: Provider,
    runtime: Runtime,
    prompt: string,
    context: ChainContext,
    signal: AbortSignal,
  ): Promise<ChainResult> {
    let sessionId = context.persistent ? runtime.sessionId : undefined
    let nextPrompt = prompt

    for (let round = 1; ; round++) {
      const turn = await this.#runSingleTurn(agent, provider, runtime, nextPrompt, sessionId, context, signal)
      if (turn.status !== "done") {
        this.#setStatus(agent.id, turn.status)
        return { status: turn.status, output: turn.output }
      }

      sessionId = turn.sessionId ?? sessionId
      if (context.persistent) runtime.sessionId = sessionId

      const delegation = this.#subagentsOf(agent).length > 0 ? parseDelegation(turn.output) : null
      if (!delegation) {
        this.#setStatus(agent.id, "done")
        return { status: "done", output: turn.output }
      }

      this.#replaceText(agent.id, turn.textEntryId, delegation.text)

      if (round >= MAX_ROUNDS_PER_CHAIN) {
        const output = `Stopped after ${MAX_ROUNDS_PER_CHAIN} rounds of delegation.`
        this.#addEntry(agent.id, "error", output)
        this.#setStatus(agent.id, "failed")
        return { status: "failed", output }
      }

      if (delegation.error) {
        this.#addEntry(agent.id, "error", delegation.error)
        nextPrompt = formatDelegationError(delegation.error)
        continue
      }

      this.#setStatus(agent.id, "waiting")
      const results = await this.#runSubagents(agent, delegation.tasks, context, signal)
      if (signal.aborted) {
        this.#addEntry(agent.id, "info", "Cancelled")
        this.#setStatus(agent.id, "cancelled")
        return { status: "cancelled", output: "" }
      }

      for (const result of results) {
        this.#addEntry(agent.id, "tool", `← ${result.agent}: ${result.status}`)
      }
      nextPrompt = formatResults(results)
    }
  }

  async #runSubagents(
    parent: Agent,
    tasks: DelegationTask[],
    context: ChainContext,
    signal: AbortSignal,
  ): Promise<DelegationResult[]> {
    const parentMode = lowerMode(context.maxMode, parent.mode, this.#state.mode)

    return mapWithLimit(tasks, MAX_PARALLEL_SUBAGENTS, async ({ agent: id, task }) => {
      this.#addEntry(parent.id, "tool", `→ ${id}: ${truncateDetail(task)}`)

      const fail = (output: string): DelegationResult => {
        this.#addEntry(parent.id, "error", output)
        return { agent: id, status: "failed", output }
      }
      const child = this.#agent(id)
      if (!child || !parent.subagents.includes(id)) {
        return fail(`"${id}" isn't one of ${parent.name}'s subagents.`)
      }
      if (context.depth + 1 > MAX_DELEGATION_DEPTH) {
        return fail(`Delegation chains can have at most ${MAX_DELEGATION_DEPTH} steps.`)
      }

      this.#addEntry(child.id, "user", `[${parent.name}] ${task}`)
      const result = await this.#runChain(child, task, {
        persistent: false,
        depth: context.depth + 1,
        maxMode: parentMode,
        parentSignal: signal,
      })
      return { agent: id, status: result.status, output: result.output }
    })
  }

  async #runSingleTurn(
    agent: Agent,
    provider: Provider,
    runtime: Runtime,
    prompt: string,
    sessionId: string | undefined,
    context: ChainContext,
    signal: AbortSignal,
  ) {
    runtime.pendingSessionId = undefined
    runtime.textOpen = false
    runtime.lastTextEntryId = undefined
    this.#setStatus(agent.id, "running")

    const result = await this.#run(
      provider,
      {
        prompt,
        cwd: this.#cwd,
        mode: lowerMode(context.maxMode, agent.mode, this.#state.mode),
        sessionId,
        model: agent.model,
        instructions: buildInstructions(agent, this.#subagentsOf(agent)) || undefined,
      },
      (event) => this.#handleEvent(agent.id, runtime, event),
      signal,
    ).catch((error: unknown) => ({ status: "failed" as const, message: String(error) }))

    runtime.textOpen = false
    if (result.message) this.#addEntry(agent.id, "error", result.message)
    if (result.status === "cancelled") this.#addEntry(agent.id, "info", "Cancelled")

    const entries = this.#pane(agent.id)?.entries ?? []
    const textEntryId = runtime.lastTextEntryId
    const lastError = entries.findLast((entry) => entry.kind === "error")
    const text = entries.find((entry) => entry.id === textEntryId)?.text ?? ""

    return {
      status: result.status,
      // A session that never finished a turn may not be resumable, as when
      // authentication fails right after the session starts.
      sessionId: result.status === "done" ? runtime.pendingSessionId : undefined,
      textEntryId,
      output: result.status === "failed" ? (result.message ?? lastError?.text ?? text) : text,
    }
  }

  #handleEvent(id: string, runtime: Runtime, event: ProviderEvent): void {
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
          runtime.lastTextEntryId = this.#addEntry(id, "assistant", event.text)
        }
        break
      case "tool":
        runtime.textOpen = false
        this.#addEntry(id, "tool", event.detail ? `${event.name}: ${event.detail}` : event.name)
        break
      case "error": {
        runtime.textOpen = false
        // Codex reports the same failure through both `error` and `turn.failed`.
        const last = this.#pane(id)?.entries.at(-1)
        if (last?.kind !== "error" || last.text !== event.message) {
          this.#addEntry(id, "error", event.message)
        }
        break
      }
    }
  }

  #agent(id: string): Agent | undefined {
    return this.#state.agents.find((agent) => agent.id === id)
  }

  #subagentsOf(agent: Agent): Agent[] {
    return agent.subagents.flatMap((id) => this.#agent(id) ?? [])
  }

  #pane(id: string): Pane | undefined {
    return this.#state.panes.find((pane) => pane.id === id)
  }

  #setStatus(id: string, status: PaneStatus): void {
    this.#updatePane(id, (pane) => ({ ...pane, status }))
  }

  #addEntry(id: string, kind: EntryKind, text: string): number {
    const entry: Entry = { id: this.#nextEntryId++, kind, text }
    this.#updatePane(id, (pane) => ({ ...pane, entries: [...pane.entries, entry] }))
    return entry.id
  }

  /** Removes the entry if there's no text left. */
  #replaceText(id: string, entryId: number | undefined, text: string): void {
    this.#updatePane(id, (pane) => ({
      ...pane,
      entries: pane.entries.flatMap((entry) => {
        if (entry.id !== entryId) return [entry]
        return text ? [{ ...entry, text }] : []
      }),
    }))
  }

  /** Targets an ID because a parent can queue a task here during a stream. */
  #appendToEntry(id: string, entryId: number | undefined, text: string): void {
    this.#updatePane(id, (pane) => ({
      ...pane,
      entries: pane.entries.map((entry) =>
        entry.id === entryId ? { ...entry, text: entry.text + text } : entry,
      ),
    }))
  }

  #updatePane(id: string, update: (pane: Pane) => Pane): void {
    this.#setState({
      ...this.#state,
      panes: this.#state.panes.map((pane) => (pane.id === id ? update(pane) : pane)),
    })
  }

  #setState(state: OrchestratorState): void {
    this.#state = state
    this.#notifyTimer ??= setTimeout(() => {
      this.#notifyTimer = undefined
      for (const listener of this.#listeners) listener()
    }, NOTIFY_INTERVAL_MS)
  }
}
