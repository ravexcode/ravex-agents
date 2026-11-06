import type { InputRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useRef, useState, useSyncExternalStore } from "react"
import { validateAgent } from "./agents/identity.ts"
import type { AgentStore, LoadErrors } from "./agents/store.ts"
import type { Agent, AgentDefinition, SavableOrigin } from "./agents/types.ts"
import { permissionWarning, type Team } from "./core/team.ts"
import type { ListModels } from "./providers/models.ts"
import type { ProviderId } from "./providers/types.ts"
import { AgentForm } from "./ui/agent-form.tsx"
import { ChatPanel, RoomPanel } from "./ui/conversation.tsx"
import { TaskDetail } from "./ui/task-detail.tsx"
import { TaskPanel } from "./ui/task-panel.tsx"
import { TeamScreen } from "./ui/team-screen.tsx"
import { ACCENT, DANGER, MUTED, WARNING } from "./ui/theme.ts"

// Below this width, the conversation needs the room more than the tasks do.
const MIN_TASK_PANEL_TERMINAL_WIDTH = 70
const ORCHESTRATOR_VIEW = "@orchestrator"
const ROOM_VIEW = "@room"
// The tabs, the input and the hints.
const MAIN_FIXED_LINES = 5

type Screen =
  | { kind: "main" }
  | { kind: "team" }
  | { kind: "form"; agent?: Agent }
  | { kind: "confirm-delete"; agent: Agent }
  | { kind: "task"; id: number }

export interface AppProps {
  team: Team
  store: AgentStore
  providerIds: ProviderId[]
  listModels: ListModels
  initialErrors?: LoadErrors
  initialNotice?: string
}

interface Tab {
  id: string
  label: string
}

/** Keeps the selected tab on screen when they don't all fit. */
function visibleTabs(tabs: Tab[], selected: number, width: number): Tab[] {
  const size = (tab: Tab) => tab.label.length + 3
  let used = size(tabs[selected] ?? { id: "", label: "" })
  let first = selected
  let last = selected
  for (let moved = true; moved; ) {
    moved = false
    const after = tabs[last + 1]
    if (after && used + size(after) <= width) {
      used += size(after)
      last++
      moved = true
    }
    const before = tabs[first - 1]
    if (before && used + size(before) <= width) {
      used += size(before)
      first--
      moved = true
    }
  }
  return tabs.slice(first, last + 1)
}

export function App({ team, store, providerIds, listModels, initialErrors = {}, initialNotice }: AppProps) {
  const state = useSyncExternalStore(team.subscribe, team.getState)
  const { width, height } = useTerminalDimensions()
  const [view, setView] = useState(ORCHESTRATOR_VIEW)
  const [screen, setScreen] = useState<Screen>({ kind: "main" })
  const [notice, setNotice] = useState(initialNotice)
  const [errors, setErrors] = useState<LoadErrors>(initialErrors)
  const [panelFocused, setPanelFocused] = useState(false)
  const [taskCursor, setTaskCursor] = useState(0)
  const [teamCursor, setTeamCursor] = useState(0)
  const [closeArmed, setCloseArmed] = useState(false)
  // The renderable owns the text: Enter can arrive before React has seen the
  // latest keystrokes, so a controlled value could fail to clear.
  const input = useRef<InputRenderable>(null)

  const { board, agents, orchestratorId, panes } = state
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id
  const orchestratorPane = panes.find((pane) => pane.id === orchestratorId)
  const agentTabs = agents.filter((agent) => agent.id !== orchestratorId)
  const tabs: Tab[] = [
    { id: ORCHESTRATOR_VIEW, label: "Orquestador" },
    { id: ROOM_VIEW, label: "Sala" },
    ...agentTabs.map((agent) => {
      const running = panes.find((pane) => pane.id === agent.id)?.status === "running"
      return { id: agent.id, label: `${running ? "● " : ""}${agent.name}` }
    }),
  ]
  const tabIndex = Math.max(0, tabs.findIndex((tab) => tab.id === view))
  const currentView = tabs[tabIndex]?.id ?? ORCHESTRATOR_VIEW
  const cursor = Math.max(0, Math.min(taskCursor, board.tasks.length - 1))
  const selectedTask = board.tasks[cursor]

  const reload = () => {
    const result = store.load()
    team.setTeam(result.agents, result.orchestratorId)
    setErrors(result.errors)
    return result
  }

  const saveAgent = (definition: AgentDefinition, origin: SavableOrigin, editing?: Agent) => {
    const invalid = validateAgent(definition, agents, editing?.id)
    if (invalid) return invalid

    const previousOrigin = editing && editing.origin !== "builtin" ? editing.origin : undefined
    try {
      store.save(definition, origin, previousOrigin)
    } catch (error) {
      return `No se pudo guardar: ${error instanceof Error ? error.message : String(error)}`
    }
    reload()
    setScreen({ kind: "team" })
    return undefined
  }

  const openDelete = (agent: Agent) => {
    if (agent.origin === "builtin") {
      setNotice(`${agent.name} es un agente base. Edítalo para cambiarlo, o crea uno nuevo con n.`)
    } else if (team.isBusy(agent.id)) {
      setNotice(`${agent.name} está trabajando. Cancélalo primero.`)
    } else {
      setNotice(undefined)
      setScreen({ kind: "confirm-delete", agent })
    }
  }

  const chooseOrchestrator = (agent: Agent) => {
    if (team.isBusy(orchestratorId) || board.phase === "planning" || board.phase === "wrapping-up") {
      setNotice("El orquestador está trabajando. Cancélalo primero.")
      return
    }
    try {
      store.setOrchestrator(agent.id, agent.origin === "project" ? "project" : "global")
      reload()
      setNotice(`${agent.name} es ahora el orquestador.`)
    } catch (error) {
      setNotice(`No se pudo guardar: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const reassignSelected = () => {
    if (!selectedTask) return
    const workers = team.workers()
    if (workers.length === 0) {
      setNotice("No hay agentes disponibles.")
      return
    }
    const position = workers.findIndex((agent) => agent.id === selectedTask.assignee)
    const next = workers[(position + 1) % workers.length]
    if (next) setNotice(team.reassign(selectedTask.id, next.id))
  }

  const handleEscape = () => {
    if (currentView === ROOM_VIEW) {
      team.cancelRoom()
    } else if (currentView !== ORCHESTRATOR_VIEW) {
      team.cancelAgent(currentView)
    } else if (board.phase === "proposed") {
      team.discardPlan()
    } else if (board.phase === "running") {
      team.stopWork()
      team.cancelAgent(orchestratorId)
    } else if (board.phase === "paused") {
      if (!closeArmed) {
        setNotice("Pulsa Esc otra vez para cerrar el objetivo y cancelar lo que queda.")
        setCloseArmed(true)
        return
      }
      team.closeGoal()
    } else {
      team.cancelAgent(orchestratorId)
    }
    setNotice(undefined)
    setCloseArmed(false)
  }

  useKeyboard((key) => {
    if (screen.kind === "confirm-delete") {
      if (key.name === "y") {
        try {
          if (screen.agent.origin !== "builtin") store.delete(screen.agent.id, screen.agent.origin)
          const result = reload()
          setTeamCursor((current) => Math.max(0, Math.min(current, result.agents.length - 1)))
          setNotice(
            store.isBuiltin(screen.agent.id)
              ? `${screen.agent.name} ha vuelto a su versión original.`
              : `${screen.agent.name} borrado.`,
          )
        } catch (error) {
          setNotice(`No se pudo borrar: ${error instanceof Error ? error.message : String(error)}`)
        }
        setScreen({ kind: "team" })
      } else if (key.name === "n" || key.name === "escape") {
        setScreen({ kind: "team" })
      }
      return
    }
    if (screen.kind !== "main") return

    if (panelFocused) {
      if (key.name === "escape" || (key.ctrl && key.name === "t")) {
        setPanelFocused(false)
      } else if (key.name === "up" || key.name === "down") {
        const count = board.tasks.length
        if (count > 0) setTaskCursor((cursor + (key.name === "up" ? count - 1 : 1)) % count)
      } else if ((key.name === "return" || key.name === "enter") && selectedTask) {
        setScreen({ kind: "task", id: selectedTask.id })
      } else if (key.name === "r") {
        reassignSelected()
      }
      return
    }

    if (key.name === "tab") {
      const step = key.shift ? tabs.length - 1 : 1
      setNotice(undefined)
      setCloseArmed(false)
      setView(tabs[(tabIndex + step) % tabs.length]?.id ?? ORCHESTRATOR_VIEW)
    } else if (key.name === "escape") {
      handleEscape()
    } else if (key.ctrl && key.name === "e") {
      team.toggleMode()
    } else if (key.ctrl && key.name === "t") {
      setNotice(undefined)
      setPanelFocused(true)
    } else if (key.ctrl && key.name === "g") {
      setNotice(undefined)
      setScreen({ kind: "team" })
      // Some CLIs take seconds to list models, so the form shouldn't be the first to ask.
      for (const provider of providerIds) listModels(provider).catch(() => {})
    }
  })

  const submit = () => {
    if (!input.current) return
    const text = input.current.value
    input.current.value = ""
    setCloseArmed(false)

    if (currentView === ROOM_VIEW) {
      setNotice(team.sendToRoom(text))
    } else if (currentView !== ORCHESTRATOR_VIEW) {
      setNotice(team.sendToAgent(currentView, text))
    } else if (text.trim()) {
      setNotice(team.sendToOrchestrator(text))
    } else if (board.phase === "proposed") {
      setNotice(team.approve())
    } else if (board.phase === "paused") {
      setNotice(team.resume())
    }
  }

  const modeLabel = (
    <text fg={state.mode === "edit" ? WARNING : MUTED}>{state.mode === "edit" ? " EDICIÓN" : " SOLO LECTURA"}</text>
  )

  const errorLines = Object.values(errors).map((line) => (
    <text key={line} fg={DANGER}>{` No se cargó, y guardar está bloqueado: ${line}`}</text>
  ))

  if (screen.kind === "form") {
    const editing = screen.agent
    return (
      <box flexDirection="column" flexGrow={1}>
        <AgentForm
          agent={editing}
          providerIds={providerIds}
          listModels={listModels}
          onSave={(definition, origin) => saveAgent(definition, origin, editing)}
          onCancel={() => setScreen({ kind: "team" })}
        />
      </box>
    )
  }

  if (screen.kind === "team" || screen.kind === "confirm-delete") {
    return (
      <box flexDirection="column" flexGrow={1}>
        <TeamScreen
          agents={agents}
          orchestratorId={orchestratorId}
          cursor={Math.max(0, Math.min(teamCursor, agents.length - 1))}
          height={height}
          onMove={(next) => {
            setNotice(undefined)
            setTeamCursor(next)
          }}
          onNew={() => {
            if (screen.kind === "team") setScreen({ kind: "form" })
          }}
          onEdit={(agent) => {
            if (screen.kind !== "team") return
            if (team.isBusy(agent.id)) setNotice(`${agent.name} está trabajando. Cancélalo primero.`)
            else setScreen({ kind: "form", agent })
          }}
          onDelete={(agent) => {
            if (screen.kind === "team") openDelete(agent)
          }}
          onChooseOrchestrator={(agent) => {
            if (screen.kind === "team") chooseOrchestrator(agent)
          }}
          onClose={() => {
            if (screen.kind === "team") {
              setNotice(undefined)
              setScreen({ kind: "main" })
            }
          }}
        />
        {screen.kind === "confirm-delete" && (
          <text fg={WARNING}>
            {store.isBuiltin(screen.agent.id)
              ? ` ¿Restaurar ${screen.agent.name} a su versión original? y confirma, n cancela.`
              : ` ¿Borrar ${screen.agent.name}? y confirma, n cancela.`}
          </text>
        )}
        {notice && <text fg={WARNING}>{` ${notice}`}</text>}
        {errorLines}
      </box>
    )
  }

  if (screen.kind === "task") {
    const task = board.tasks.find((candidate) => candidate.id === screen.id)
    if (task) {
      return (
        <TaskDetail
          task={task}
          entries={(panes.find((pane) => pane.id === task.assignee)?.entries ?? []).filter((entry) => entry.taskId === task.id)}
          nameOf={nameOf}
          onComment={(text) => team.comment(task.id, text)}
          onClose={() => setScreen({ kind: "main" })}
        />
      )
    }
  }

  const warning =
    board.phase === "proposed" || board.phase === "paused" ? permissionWarning(state) : undefined
  const wide = width >= MIN_TASK_PANEL_TERMINAL_WIDTH
  const onOrchestrator = currentView === ORCHESTRATOR_VIEW
  const pane = panes.find((candidate) => candidate.id === currentView)
  const extraLines =
    (notice ? 1 : 0) + (warning ? 1 : 0) + errorLines.length + (state.saveError ? 1 : 0)

  const inputTitle = onOrchestrator
    ? " Al orquestador "
    : currentView === ROOM_VIEW
      ? " A la sala · @nombre llama a un agente "
      : ` A ${nameOf(currentView)} `

  const hints = panelFocused
    ? "↑/↓ mover · Enter abrir · r reasignar · Esc volver"
    : onOrchestrator && board.phase === "proposed"
      ? "Enter aprueba · escribe cambios · Esc descarta · ^T tareas · ^E modo"
      : onOrchestrator && board.phase === "paused"
        ? "Enter continúa · escribe qué hacer · Esc cierra el objetivo · ^T tareas"
        : "Tab conversación · ^T tareas · ^G equipo · ^E modo · Esc cancela · ^C sale"

  const shownTabs = visibleTabs(tabs, tabIndex, Math.max(10, width - 14))

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" paddingLeft={1} justifyContent="space-between" flexShrink={0}>
        <text wrapMode="none">
          {shownTabs.map((tab, position) => (
            <span key={tab.id} fg={tab.id === currentView ? ACCENT : MUTED}>
              {`${position > 0 ? " · " : ""}${tab.id === currentView ? tab.label.toUpperCase() : tab.label}`}
            </span>
          ))}
        </text>
        {modeLabel}
      </box>
      <box flexDirection="row" flexGrow={1} flexBasis={0}>
        {(wide || !panelFocused) &&
          (currentView === ROOM_VIEW ? (
            <RoomPanel messages={state.room} busy={state.roomBusy} nameOf={nameOf} />
          ) : (
            <>{(pane ?? orchestratorPane) && <ChatPanel pane={(pane ?? orchestratorPane)!} hideRoom={onOrchestrator} />}</>
          ))}
        {(wide || panelFocused) && (
          <TaskPanel
            board={board}
            cursor={cursor}
            focused={panelFocused}
            height={height - MAIN_FIXED_LINES - extraLines}
            nameOf={nameOf}
            grow={!wide}
          />
        )}
      </box>
      <box border borderColor={panelFocused ? MUTED : ACCENT} title={inputTitle} height={3} flexShrink={0}>
        <input
          ref={input}
          focused={screen.kind === "main" && !panelFocused}
          placeholder={onOrchestrator ? "Describe un objetivo…" : "Escribe un mensaje…"}
          onSubmit={submit}
        />
      </box>
      {warning && warning !== notice && (
        <text fg={WARNING} wrapMode="none">{` ${warning}`}</text>
      )}
      {notice && <text fg={WARNING}>{` ${notice}`}</text>}
      {state.saveError && <text fg={DANGER}>{` No se pudo guardar el estado: ${state.saveError}`}</text>}
      {errorLines}
      <text fg={MUTED} wrapMode="none">{` ${hints}`}</text>
    </box>
  )
}
