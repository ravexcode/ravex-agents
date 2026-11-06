import { TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useRef, useState, useSyncExternalStore } from "react"
import { validateAgent } from "./agents/identity.ts"
import type { Skill } from "./agents/skills.ts"
import type { AgentStore, LoadErrors } from "./agents/store.ts"
import type { Agent, AgentDefinition, SavableOrigin } from "./agents/types.ts"
import { permissionWarning, type Team } from "./core/team.ts"
import type { ListModels } from "./providers/models.ts"
import type { Provider } from "./providers/types.ts"
import { AgentForm } from "./ui/agent-form.tsx"
import { ChatPanel, RoomPanel } from "./ui/conversation.tsx"
import { isSettingsKey, useKeys } from "./ui/keys.ts"
import { Logo } from "./ui/logo.tsx"
import { Prompt } from "./ui/prompt.tsx"
import { SettingsScreen } from "./ui/settings-screen.tsx"
import { TaskDetail } from "./ui/task-detail.tsx"
import { TaskPanel } from "./ui/task-panel.tsx"
import { TeamScreen } from "./ui/team-screen.tsx"
import { ACCENT, DANGER, MUTED, WARNING } from "./ui/theme.ts"

// Below this width, the conversation needs the room more than the tasks do.
const MIN_TASK_PANEL_TERMINAL_WIDTH = 70
const ORCHESTRATOR_VIEW = "@orchestrator"
const ROOM_VIEW = "@room"
// The tabs, the space under them, the prompt, the space over it and the hints.
const MAIN_FIXED_LINES = 5
// The conversation's title and the space under it, on top of the fixed lines.
const LOGO_TOP_LINES = 4
// Those two, and the spinner.
const LOGO_EXTRA_LINES = 3
const SCROLL_PAGE_LINES = 10
const MODE_WIDTH = 11

type Screen =
  | { kind: "main" }
  | { kind: "settings" }
  | { kind: "team" }
  | { kind: "form"; agent?: Agent }
  | { kind: "confirm-delete"; agent: Agent }
  | { kind: "task"; id: number }

export interface AppProps {
  team: Team
  store: AgentStore
  providers: Provider[]
  listModels: ListModels
  listSkills: () => Skill[]
  initialErrors?: LoadErrors
  initialNotice?: string
}

interface Tab {
  id: string
  label: string
}

/** Keeps the selected tab on screen when they don't all fit. */
function visibleTabs(tabs: Tab[], selected: number, width: number): Tab[] {
  const size = (tab: Tab) => tab.label.length + 2
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

export function App({ team, store, providers, listModels, listSkills, initialErrors = {}, initialNotice }: AppProps) {
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
  const scroll = useRef<ScrollBoxRenderable>(null)

  const { board, agents, orchestratorId, panes } = state
  const providerIds = providers.map((provider) => provider.id)
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id
  const orchestratorPane = panes.find((pane) => pane.id === orchestratorId)
  const agentTabs = agents.filter((agent) => agent.id !== orchestratorId)
  const tabs: Tab[] = [
    { id: ORCHESTRATOR_VIEW, label: "Orchestrator" },
    { id: ROOM_VIEW, label: "Room" },
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
      return `Couldn't save: ${error instanceof Error ? error.message : String(error)}`
    }
    reload()
    setScreen({ kind: "team" })
    return undefined
  }

  const openDelete = (agent: Agent) => {
    if (agent.origin === "builtin") {
      setNotice(`${agent.name} is built in. Edit it to change it, or press n to create your own.`)
    } else if (team.isBusy(agent.id)) {
      setNotice(`${agent.name} is working. Cancel it first.`)
    } else {
      setNotice(undefined)
      setScreen({ kind: "confirm-delete", agent })
    }
  }

  const chooseOrchestrator = (agent: Agent) => {
    if (team.isBusy(orchestratorId) || board.phase === "planning" || board.phase === "wrapping-up") {
      setNotice("The orchestrator is working. Cancel it first.")
      return
    }
    try {
      store.setOrchestrator(agent.id, agent.origin === "project" ? "project" : "global")
      reload()
      setNotice(`${agent.name} is now the orchestrator.`)
    } catch (error) {
      setNotice(`Couldn't save: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const reassignSelected = () => {
    if (!selectedTask) return
    const workers = team.workers()
    if (workers.length === 0) {
      setNotice("No agents are available.")
      return
    }
    const position = workers.findIndex((agent) => agent.id === selectedTask.assignee)
    const next = workers[(position + 1) % workers.length]
    if (next) setNotice(team.reassign(selectedTask.id, next.id))
  }

  const openFromMain = (next: Screen) => {
    setNotice(undefined)
    setScreen(next)
    // Some CLIs take seconds to list models, so the form shouldn't be the first to ask.
    for (const provider of providerIds) listModels(provider).catch(() => {})
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
        setNotice("Press Esc again to close the goal and cancel what's left.")
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

  useKeys((key) => {
    if (screen.kind === "confirm-delete") {
      if (key.name === "y") {
        try {
          if (screen.agent.origin !== "builtin") store.delete(screen.agent.id, screen.agent.origin)
          const result = reload()
          setTeamCursor((current) => Math.max(0, Math.min(current, result.agents.length - 1)))
          setNotice(
            store.isBuiltin(screen.agent.id)
              ? `${screen.agent.name} is back to its original version.`
              : `Deleted ${screen.agent.name}.`,
          )
        } catch (error) {
          setNotice(`Couldn't delete: ${error instanceof Error ? error.message : String(error)}`)
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
    } else if (key.name === "pageup") {
      scroll.current?.scrollBy(-SCROLL_PAGE_LINES)
    } else if (key.name === "pagedown") {
      scroll.current?.scrollBy(SCROLL_PAGE_LINES)
    } else if (key.ctrl && key.name === "e") {
      team.toggleMode()
    } else if (key.ctrl && key.name === "t") {
      if (board.tasks.length === 0) {
        setNotice("No tasks yet.")
      } else {
        setNotice(undefined)
        setPanelFocused(true)
      }
    } else if (isSettingsKey(key)) {
      openFromMain({ kind: "settings" })
    } else if (key.ctrl && key.name === "g") {
      openFromMain({ kind: "team" })
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

  const errorLines = Object.values(errors).map((line) => (
    <text key={line} fg={DANGER}>{` Not loaded, and saving is blocked: ${line}`}</text>
  ))

  if (screen.kind === "form") {
    const editing = screen.agent
    return (
      <AgentForm
        agent={editing}
        providerIds={providerIds}
        lockedTools={(id) => providers.find((provider) => provider.id === id)?.lockedTools ?? []}
        listModels={listModels}
        listSkills={listSkills}
        onSave={(definition, origin) => saveAgent(definition, origin, editing)}
        onCancel={() => setScreen({ kind: "team" })}
      />
    )
  }

  if (screen.kind === "settings") {
    return (
      <box flexDirection="column" flexGrow={1}>
        <SettingsScreen
          mode={state.mode}
          onNewAgent={() => setScreen({ kind: "form" })}
          onTeam={() => setScreen({ kind: "team" })}
          onToggleMode={() => team.toggleMode()}
          onClose={() => setScreen({ kind: "main" })}
        />
        {errorLines}
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
            if (team.isBusy(agent.id)) setNotice(`${agent.name} is working. Cancel it first.`)
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
              ? ` Restore ${screen.agent.name} to its original version? y confirms, n cancels.`
              : ` Delete ${screen.agent.name}? y confirms, n cancels.`}
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
      const assignee = panes.find((pane) => pane.id === task.assignee)
      const working = assignee?.status === "running" && assignee.entries.at(-1)?.taskId === task.id
      return (
        <TaskDetail
          task={task}
          entries={(assignee?.entries ?? []).filter((entry) => entry.taskId === task.id)}
          activity={working ? assignee.activity : undefined}
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
  const hasTasks = board.tasks.length > 0
  const onOrchestrator = currentView === ORCHESTRATOR_VIEW
  const pane = panes.find((candidate) => candidate.id === currentView) ?? orchestratorPane
  const extraLines =
    (notice ? 1 : 0) + (warning && warning !== notice ? 1 : 0) + errorLines.length + (state.saveError ? 1 : 0)

  const placeholder = onOrchestrator
    ? "Describe a goal for the orchestrator…"
    : currentView === ROOM_VIEW
      ? "Message the room. @name calls an agent…"
      : `Message ${nameOf(currentView)}…`

  const hints = panelFocused
    ? "↑/↓ move · Enter open · r reassign · Esc back"
    : onOrchestrator && board.phase === "proposed"
      ? "Enter approve · type to change · Esc discard · ^T tasks · ^E mode"
      : onOrchestrator && board.phase === "paused"
        ? "Enter continue · type what to do · Esc close goal · ^T tasks"
        : "Tab switch · ^P settings · ^T tasks · ^G team · ^E mode · Esc cancel · ^C quit"

  // Each room turn starts with an entry of its own, so this can't be an older reply.
  const liveRoomEntry = panes.find((candidate) => candidate.id === state.roomBusy)?.entries.findLast((entry) => entry.room)
  const liveReply = liveRoomEntry?.kind === "assistant" ? liveRoomEntry.text : undefined

  const shownTabs = visibleTabs(tabs, tabIndex, Math.max(10, width - MODE_WIDTH - 2))

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <Logo
        width={width}
        height={height}
        fixedLines={MAIN_FIXED_LINES + LOGO_EXTRA_LINES + extraLines}
        topLines={LOGO_TOP_LINES}
      />
      <box flexDirection="row" justifyContent="space-between" marginBottom={1} flexShrink={0}>
        <text wrapMode="none">
          {shownTabs.map((tab, position) => {
            const selected = tab.id === currentView
            return (
              <span key={tab.id}>
                {position > 0 ? "  " : ""}
                <span fg={selected ? ACCENT : MUTED} attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}>
                  {tab.label}
                </span>
              </span>
            )
          })}
        </text>
        <text fg={state.mode === "edit" ? WARNING : MUTED} flexShrink={0}>
          {state.mode === "edit" ? "EDIT" : "READ-ONLY"}
        </text>
      </box>
      <box flexDirection="row" flexGrow={1} flexBasis={0}>
        {(wide || !panelFocused) &&
          (currentView === ROOM_VIEW ? (
            <RoomPanel messages={state.room} busy={state.roomBusy} liveReply={liveReply} nameOf={nameOf} scrollRef={scroll} />
          ) : (
            pane && <ChatPanel pane={pane} hideRoom={onOrchestrator} scrollRef={scroll} />
          ))}
        {((wide && hasTasks) || panelFocused) && (
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
      <Prompt inputRef={input} focused={!panelFocused} placeholder={placeholder} onSubmit={submit} />
      {warning && warning !== notice && (
        <text fg={WARNING} wrapMode="none">
          {warning}
        </text>
      )}
      {notice && <text fg={WARNING}>{notice}</text>}
      {state.saveError && <text fg={DANGER}>{`Couldn't save the state: ${state.saveError}`}</text>}
      {errorLines}
      <text fg={MUTED} wrapMode="none" flexShrink={0}>
        {hints}
      </text>
    </box>
  )
}
