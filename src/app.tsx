import type { InputRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useMemo, useRef, useState, useSyncExternalStore } from "react"
import { buildTree, rootIds, validateAgent } from "./agents/graph.ts"
import type { AgentStore, LoadErrors } from "./agents/store.ts"
import type { Agent, AgentDefinition, SavableOrigin } from "./agents/types.ts"
import { ALL_AGENTS, type Orchestrator, type Target } from "./orchestrator.ts"
import type { ProviderId } from "./providers/types.ts"
import { AgentForm } from "./ui/agent-form.tsx"
import { Conversation } from "./ui/conversation.tsx"
import { Sidebar, SIDEBAR_WIDTH } from "./ui/sidebar.tsx"
import { ACCENT, DANGER, MUTED, WARNING } from "./ui/theme.ts"

// Below this width, the conversation needs the room more than the tree does.
const MIN_SIDEBAR_TERMINAL_WIDTH = 70

type Screen = { kind: "main" } | { kind: "form"; agent?: Agent } | { kind: "confirm-delete"; agent: Agent }

export interface AppProps {
  orchestrator: Orchestrator
  store: AgentStore
  providerIds: ProviderId[]
  initialErrors?: LoadErrors
}

export function App({ orchestrator, store, providerIds, initialErrors = {} }: AppProps) {
  const state = useSyncExternalStore(orchestrator.subscribe, orchestrator.getState)
  const { width } = useTerminalDimensions()
  const [target, setTarget] = useState<Target>(ALL_AGENTS)
  const [screen, setScreen] = useState<Screen>({ kind: "main" })
  const [notice, setNotice] = useState<string>()
  const [errors, setErrors] = useState<LoadErrors>(initialErrors)
  // The renderable owns the text: Enter can arrive before React has seen the
  // latest keystrokes, so a controlled value could fail to clear.
  const input = useRef<InputRenderable>(null)

  const roots = useMemo(() => rootIds(state.agents), [state.agents])
  const selected = state.agents.find((agent) => agent.id === target)
  // Follows the tree on screen, where an agent with two parents appears twice.
  const targets = useMemo<Target[]>(
    () => [ALL_AGENTS, ...new Set(buildTree(state.agents).map((row) => row.agentId))],
    [state.agents],
  )

  const reload = () => {
    const result = store.load()
    orchestrator.setAgents(result.agents)
    setErrors(result.errors)
  }

  const saveAgent = (definition: AgentDefinition, origin: SavableOrigin, editing?: Agent) => {
    const invalid = validateAgent(definition, state.agents, editing?.id)
    if (invalid) return invalid

    const previousOrigin = editing && editing.origin !== "builtin" ? editing.origin : undefined
    try {
      store.save(definition, origin, previousOrigin)
    } catch (error) {
      return `Couldn't save to ${origin}: ${error instanceof Error ? error.message : String(error)}`
    }
    reload()
    setTarget(definition.id)
    setScreen({ kind: "main" })
    return undefined
  }

  /** Returns the selected agent if the user may change it, or explains why not. */
  const changeableAgent = (): Agent | undefined => {
    if (!selected) {
      setNotice("Select an agent first.")
    } else if (selected.origin === "builtin") {
      setNotice(`${selected.name} is built in. Press Ctrl+N to create your own agent.`)
    } else if (orchestrator.isBusy(selected.id)) {
      setNotice(`${selected.name} is running. Press Esc to cancel it first.`)
    } else {
      return selected
    }
    return undefined
  }

  useKeyboard((key) => {
    if (screen.kind === "confirm-delete") {
      if (key.name === "y") {
        try {
          if (screen.agent.origin !== "builtin") store.delete(screen.agent.id, screen.agent.origin)
          reload()
          setTarget(ALL_AGENTS)
          setNotice(`Deleted ${screen.agent.name}.`)
        } catch (error) {
          setNotice(`Couldn't delete: ${error instanceof Error ? error.message : String(error)}`)
        }
        setScreen({ kind: "main" })
      } else if (key.name === "n" || key.name === "escape") {
        setScreen({ kind: "main" })
      }
      return
    }
    if (screen.kind !== "main") return

    if (key.name === "tab") {
      const step = key.shift ? targets.length - 1 : 1
      setNotice(undefined)
      setTarget((current) => targets[(targets.indexOf(current) + step) % targets.length] ?? ALL_AGENTS)
    } else if (key.name === "escape") {
      orchestrator.cancel(target)
    } else if (key.ctrl && key.name === "e") {
      orchestrator.toggleMode()
    } else if (key.ctrl && key.name === "n") {
      setNotice(undefined)
      setScreen({ kind: "form" })
    } else if (key.ctrl && key.name === "o") {
      const agent = changeableAgent()
      if (agent) {
        setNotice(undefined)
        setScreen({ kind: "form", agent })
      }
    } else if (key.ctrl && key.name === "x") {
      const agent = changeableAgent()
      if (agent) {
        setNotice(undefined)
        setScreen({ kind: "confirm-delete", agent })
      }
    }
  })

  const header = (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} justifyContent="space-between" flexShrink={0}>
      <text fg={MUTED}>
        {screen.kind === "form"
          ? ""
          : "Tab select · Esc cancel · ^N new · ^O edit · ^X delete · ^E mode · ^C quit"}
      </text>
      <text fg={state.mode === "edit" ? WARNING : MUTED}>{state.mode === "edit" ? "EDIT" : "READ-ONLY"}</text>
    </box>
  )

  const errorLines = Object.values(errors)

  if (screen.kind === "form") {
    const editing = screen.agent
    return (
      <box flexDirection="column" flexGrow={1}>
        <AgentForm
          agent={editing}
          agents={state.agents}
          providerIds={providerIds}
          onSave={(definition, origin) => saveAgent(definition, origin, editing)}
          onCancel={() => setScreen({ kind: "main" })}
        />
        {header}
      </box>
    )
  }

  const shownPanes =
    target === ALL_AGENTS
      ? state.panes.filter((pane) => roots.includes(pane.id))
      : state.panes.filter((pane) => pane.id === target)
  const showSidebar = width >= MIN_SIDEBAR_TERMINAL_WIDTH
  const conversationWidth = showSidebar ? width - SIDEBAR_WIDTH : width
  const targetLabel = target === ALL_AGENTS ? `All (${roots.length})` : (selected?.name ?? target)

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexGrow={1}>
        {showSidebar && <Sidebar agents={state.agents} panes={state.panes} target={target} />}
        <Conversation panes={shownPanes} width={conversationWidth} />
      </box>
      <box border borderColor={ACCENT} title={` To: ${targetLabel} `} height={3} flexShrink={0}>
        <input
          ref={input}
          focused={screen.kind === "main"}
          placeholder="Send a prompt…"
          onSubmit={() => {
            if (!input.current) return
            orchestrator.send(target, input.current.value)
            input.current.value = ""
          }}
        />
      </box>
      {screen.kind === "confirm-delete" && (
        <text fg={WARNING}>{` Delete ${screen.agent.name}? Press y to delete or n to keep it.`}</text>
      )}
      {notice && <text fg={WARNING}>{` ${notice}`}</text>}
      {errorLines.map((line) => (
        <text key={line} fg={DANGER}>{` Not loaded, and saving is blocked: ${line}`}</text>
      ))}
      {header}
    </box>
  )
}
