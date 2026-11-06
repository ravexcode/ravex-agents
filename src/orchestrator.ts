import { runTurn, type RunTurn } from "./providers/runner.ts"
import type { PermissionMode, Provider, ProviderEvent, ProviderId } from "./providers/types.ts"

// Providers can stream many deltas per frame; this caps re-renders at about 30 per second.
const NOTIFY_INTERVAL_MS = 33

export type Target = ProviderId | "all"
export type PaneStatus = "idle" | "running" | "done" | "failed" | "cancelled"
export type EntryKind = "user" | "assistant" | "tool" | "error" | "info"

export interface Entry {
  id: number
  kind: EntryKind
  text: string
}

export interface Pane {
  id: ProviderId
  label: string
  available: boolean
  status: PaneStatus
  entries: Entry[]
}

export interface OrchestratorState {
  mode: PermissionMode
  panes: Pane[]
}

export interface OrchestratorOptions {
  cwd?: string
  run?: RunTurn
  isAvailable?: (provider: Provider) => boolean
}

interface Conversation {
  sessionId?: string
  pendingSessionId?: string
  controller?: AbortController
  /** Whether the next text delta continues the last assistant entry. */
  textOpen: boolean
}

export class Orchestrator {
  readonly #providers: Map<ProviderId, Provider>
  readonly #conversations = new Map<ProviderId, Conversation>()
  readonly #listeners = new Set<() => void>()
  readonly #cwd: string
  readonly #run: RunTurn
  #state: OrchestratorState
  #nextEntryId = 1
  #notifyTimer: Timer | undefined

  constructor(providers: Provider[], options: OrchestratorOptions = {}) {
    const isAvailable =
      options.isAvailable ?? ((provider: Provider) => Bun.which(provider.binary) !== null)

    this.#providers = new Map(providers.map((provider) => [provider.id, provider]))
    this.#cwd = options.cwd ?? process.cwd()
    this.#run = options.run ?? runTurn
    this.#state = {
      mode: "read-only",
      panes: providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        available: isAvailable(provider),
        status: "idle",
        entries: [],
      })),
    }
    for (const provider of providers) {
      this.#conversations.set(provider.id, { textOpen: false })
    }
  }

  getState = (): OrchestratorState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  toggleMode(): void {
    this.#setState({
      ...this.#state,
      mode: this.#state.mode === "read-only" ? "edit" : "read-only",
    })
  }

  send(target: Target, prompt: string): void {
    const text = prompt.trim()
    if (!text) return
    for (const id of this.#resolve(target)) this.#startTurn(id, text)
  }

  cancel(target: Target): void {
    for (const id of this.#resolve(target)) this.#conversations.get(id)?.controller?.abort()
  }

  #resolve(target: Target): ProviderId[] {
    return target === "all" ? [...this.#providers.keys()] : [target]
  }

  #startTurn(id: ProviderId, prompt: string): void {
    const provider = this.#providers.get(id)
    const conversation = this.#conversations.get(id)
    const pane = this.#pane(id)
    if (!provider || !conversation || !pane) return

    if (!pane.available) {
      this.#addEntry(id, "error", `${provider.binary} was not found in PATH`)
      return
    }
    if (conversation.controller) {
      this.#addEntry(id, "info", "Still running. Press Esc to cancel, then send again.")
      return
    }

    const controller = new AbortController()
    conversation.controller = controller
    conversation.pendingSessionId = undefined
    conversation.textOpen = false
    this.#addEntry(id, "user", prompt)
    this.#updatePane(id, (current) => ({ ...current, status: "running" }))

    this.#run(
      provider,
      {
        prompt,
        cwd: this.#cwd,
        mode: this.#state.mode,
        sessionId: conversation.sessionId,
      },
      (event) => this.#handleEvent(id, event),
      controller.signal,
    )
      .catch((error: unknown) => ({ status: "failed" as const, message: String(error) }))
      .then((result) => {
        conversation.controller = undefined
        conversation.textOpen = false
        // A session that never finished a turn may not be resumable, as when
        // authentication fails right after the session starts.
        if (result.status === "done" && conversation.pendingSessionId) {
          conversation.sessionId = conversation.pendingSessionId
        }
        if ("message" in result && result.message) this.#addEntry(id, "error", result.message)
        if (result.status === "cancelled") this.#addEntry(id, "info", "Cancelled")
        this.#updatePane(id, (current) => ({ ...current, status: result.status }))
      })
  }

  #handleEvent(id: ProviderId, event: ProviderEvent): void {
    const conversation = this.#conversations.get(id)
    if (!conversation) return

    switch (event.type) {
      case "session":
        conversation.pendingSessionId = event.sessionId
        break
      case "text-start":
        conversation.textOpen = false
        break
      case "text-delta":
        if (conversation.textOpen) {
          this.#appendToLastEntry(id, event.text)
        } else if (event.text) {
          conversation.textOpen = true
          this.#addEntry(id, "assistant", event.text)
        }
        break
      case "tool":
        conversation.textOpen = false
        this.#addEntry(id, "tool", event.detail ? `${event.name}: ${event.detail}` : event.name)
        break
      case "error": {
        conversation.textOpen = false
        // Codex reports the same failure through both `error` and `turn.failed`.
        const last = this.#pane(id)?.entries.at(-1)
        if (last?.kind !== "error" || last.text !== event.message) {
          this.#addEntry(id, "error", event.message)
        }
        break
      }
    }
  }

  #pane(id: ProviderId): Pane | undefined {
    return this.#state.panes.find((pane) => pane.id === id)
  }

  #addEntry(id: ProviderId, kind: EntryKind, text: string): void {
    const entry: Entry = { id: this.#nextEntryId++, kind, text }
    this.#updatePane(id, (pane) => ({ ...pane, entries: [...pane.entries, entry] }))
  }

  #appendToLastEntry(id: ProviderId, text: string): void {
    this.#updatePane(id, (pane) => {
      const last = pane.entries.at(-1)
      if (!last) return pane
      return {
        ...pane,
        entries: [...pane.entries.slice(0, -1), { ...last, text: last.text + text }],
      }
    })
  }

  #updatePane(id: ProviderId, update: (pane: Pane) => Pane): void {
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
