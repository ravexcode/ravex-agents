import { TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/react"
import { useRef, useState, useSyncExternalStore } from "react"
import { validateAgent } from "./agents/identity.ts"
import type { Skill } from "./agents/skills.ts"
import type { AgentStore, LoadErrors } from "./agents/store.ts"
import type { Agent, AgentDefinition, SavableOrigin } from "./agents/types.ts"
import type { ArchivedConversation } from "./core/archive.ts"
import { permissionWarning, type Team } from "./core/team.ts"
import type { ListModels } from "./providers/models.ts"
import type { Provider } from "./providers/types.ts"
import { AgentForm } from "./ui/agent-form.tsx"
import { CommandMenu, MAX_MENU_LINES } from "./ui/command-menu.tsx"
import { COMMANDS, commandMatches, parseSlash, type Command } from "./ui/commands.ts"
import { ChatPanel, RoomPanel } from "./ui/conversation.tsx"
import { isSettingsKey, useKeys } from "./ui/keys.ts"
import { ListScreen } from "./ui/list-screen.tsx"
import { Logo } from "./ui/logo.tsx"
import { Prompt } from "./ui/prompt.tsx"
import { SettingsScreen } from "./ui/settings-screen.tsx"
import { TaskDetail } from "./ui/task-detail.tsx"
import { TaskPanel } from "./ui/task-panel.tsx"
import { TeamScreen } from "./ui/team-screen.tsx"
import { ACCENT, DANGER, MUTED, PANE_STATUS_LABELS, WARNING } from "./ui/theme.ts"

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
  | { kind: "help" }
  | { kind: "agents" }
  | { kind: "resume"; conversations: ArchivedConversation[] }
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

function timeAgo(time: number, now = Date.now()): string {
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
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
  const [draft, setDraft] = useState("")
  const [menuCursor, setMenuCursor] = useState(0)
  const renderer = useRenderer()
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

  const setPrompt = (text: string) => {
    if (input.current) input.current.value = text
    setDraft(text)
    setMenuCursor(0)
  }

  const openTasks = () => {
    if (board.tasks.length === 0) {
      setNotice("No tasks yet.")
    } else {
      setNotice(undefined)
      setPanelFocused(true)
    }
  }

  const backToStart = () => {
    setView(ORCHESTRATOR_VIEW)
    setTaskCursor(0)
    setCloseArmed(false)
  }

  const findAgent = (name: string) =>
    agents.find((agent) => agent.id === name.toLowerCase() || agent.name.toLowerCase() === name.toLowerCase())

  const viewOf = (agentId: string) => (agentId === orchestratorId ? ORCHESTRATOR_VIEW : agentId)

  const runCommand = (command: Command, args: string) => {
    setNotice(undefined)
    switch (command.name) {
      case "new": {
        const failed = team.startConversation()
        if (failed) {
          setNotice(failed)
        } else {
          backToStart()
          setNotice("New conversation.")
        }
        break
      }
      case "resume": {
        const conversations = team.listConversations()
        if (conversations.length === 0) setNotice("There are no earlier conversations.")
        else setScreen({ kind: "resume", conversations })
        break
      }
      case "agent": {
        if (!args) {
          setScreen({ kind: "agents" })
          break
        }
        const agent = findAgent(args)
        if (agent) setView(viewOf(agent.id))
        else setNotice(`Nobody is called "${args}". /agent lists them.`)
        break
      }
      case "team":
        openFromMain({ kind: "team" })
        break
      case "tasks":
        openTasks()
        break
      case "mode":
        if (args && args !== "edit" && args !== "read-only") setNotice("/mode takes edit or read-only.")
        else if (args !== state.mode) team.toggleMode()
        break
      case "settings":
        openFromMain({ kind: "settings" })
        break
      case "help":
        setScreen({ kind: "help" })
        break
      case "quit":
        renderer.destroy()
        break
    }
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

    const menu = commandMatches(input.current?.value ?? "")
    if (menu.length > 0) {
      const selected = menu[Math.min(menuCursor, menu.length - 1)]
      if (key.name === "escape") {
        setPrompt("")
        return
      }
      if (key.name === "up" || key.name === "down") {
        setMenuCursor((Math.min(menuCursor, menu.length - 1) + (key.name === "up" ? menu.length - 1 : 1)) % menu.length)
        return
      }
      if (key.name === "tab" && selected) {
        setPrompt(`/${selected.name}${selected.args ? " " : ""}`)
        return
      }
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
      openTasks()
    } else if (isSettingsKey(key)) {
      openFromMain({ kind: "settings" })
    } else if (key.ctrl && key.name === "g") {
      openFromMain({ kind: "team" })
    }
  })

  const submit = () => {
    if (!input.current) return
    const text = input.current.value
    setCloseArmed(false)

    const offered = commandMatches(text)
    const selected = offered[Math.min(menuCursor, offered.length - 1)]
    const slash = selected ? { command: selected, args: "" } : parseSlash(text)
    if (slash && "unknown" in slash) {
      // Kept in the prompt, in case it was a message rather than a mistyped command.
      setNotice(`/${slash.unknown} isn't a command. Type / to see them, or start with a space to send it as a message.`)
      return
    }
    if (slash && slash.args && !slash.command.args) {
      setNotice(`/${slash.command.name} doesn't take anything after it.`)
      return
    }

    setPrompt("")
    if (slash) {
      runCommand(slash.command, slash.args)
    } else if (currentView === ROOM_VIEW) {
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

  if (screen.kind === "help") {
    return (
      <ListScreen
        title="Commands"
        labelWidth={28}
        height={height}
        hints="↑/↓ move · Enter run · Esc back"
        items={COMMANDS.map((command) => ({
          id: command.name,
          label: `/${command.name}${command.args ? ` ${command.args}` : ""}`,
          detail: command.description,
        }))}
        onSelect={(item) => {
          const command = COMMANDS.find((candidate) => candidate.name === item.id)
          setScreen({ kind: "main" })
          if (command) runCommand(command, "")
        }}
        onClose={() => setScreen({ kind: "main" })}
      />
    )
  }

  if (screen.kind === "resume") {
    return (
      <ListScreen
        title="Resume a conversation"
        labelWidth={Math.max(20, width - 26)}
        height={height}
        hints="↑/↓ move · Enter resume · Esc back"
        items={screen.conversations.map((conversation) => ({
          id: conversation.id,
          label: conversation.title,
          detail: `${timeAgo(conversation.savedAt)}${conversation.tasks ? ` · ${conversation.tasks} tasks` : ""}`,
        }))}
        onSelect={(item) => {
          const failed = team.resumeConversation(item.id)
          setScreen({ kind: "main" })
          if (!failed) backToStart()
          setNotice(failed)
        }}
        onClose={() => setScreen({ kind: "main" })}
      />
    )
  }

  if (screen.kind === "agents") {
    return (
      <box flexDirection="column" flexGrow={1}>
        <ListScreen
          title="Agents"
          labelWidth={20}
          height={height}
          hints="↑/↓ move · Enter talk to it · e change its model and more · Esc back"
          initialCursor={Math.max(0, agents.findIndex((agent) => viewOf(agent.id) === currentView))}
          items={agents.map((agent) => {
            const pane = panes.find((candidate) => candidate.id === agent.id)
            const engine = agent.model ? `${agent.provider}/${agent.model}` : agent.provider
            const status = !pane?.available ? "not installed" : PANE_STATUS_LABELS[pane.status]
            const role = agent.id === orchestratorId ? " · orchestrator" : ""
            return { id: agent.id, label: agent.name, detail: `${engine} · ${status}${role}` }
          })}
          onSelect={(item) => {
            setView(viewOf(item.id))
            setScreen({ kind: "main" })
          }}
          onKey={(key, item) => {
            const agent = agents.find((candidate) => candidate.id === item.id)
            if (key.name !== "e" || !agent) return
            if (team.isBusy(agent.id)) setNotice(`${agent.name} is working. Cancel it first.`)
            else setScreen({ kind: "form", agent })
          }}
          onClose={() => {
            setNotice(undefined)
            setScreen({ kind: "main" })
          }}
        />
        {notice && <text fg={WARNING}>{` ${notice}`}</text>}
      </box>
    )
  }

  if (screen.kind === "settings") {
    return (
      <box flexDirection="column" flexGrow={1}>
        <SettingsScreen
          mode={state.mode}
          height={height}
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
  const menu = panelFocused ? [] : commandMatches(draft)
  const menuIndex = Math.min(menuCursor, Math.max(0, menu.length - 1))
  const extraLines =
    Math.min(menu.length, MAX_MENU_LINES) +
    (notice ? 1 : 0) + (warning && warning !== notice ? 1 : 0) + errorLines.length + (state.saveError ? 1 : 0)

  const placeholder = onOrchestrator
    ? "Describe a goal for the orchestrator…"
    : currentView === ROOM_VIEW
      ? "Message the room. @name calls an agent…"
      : `Message ${nameOf(currentView)}…`

  const hints = panelFocused
    ? "↑/↓ move · Enter open · r reassign · Esc back"
    : menu.length > 0
      ? "↑/↓ move · Enter run · Tab complete · Esc close"
      : onOrchestrator && board.phase === "proposed"
        ? "Enter approve · type to change · Esc discard · ^T tasks · ^E mode"
        : onOrchestrator && board.phase === "paused"
          ? "Enter continue · type what to do · Esc close goal · ^T tasks"
          : "/ commands · Tab switch · ^P settings · ^T tasks · ^G team · ^E mode · Esc cancel"

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
      <Prompt
        inputRef={input}
        focused={!panelFocused}
        placeholder={placeholder}
        onSubmit={submit}
        onInput={(value) => {
          setDraft(value)
          setMenuCursor(0)
        }}
      />
      {menu.length > 0 && <CommandMenu commands={menu} cursor={menuIndex} />}
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
