import type { InputRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useRef, useState, useSyncExternalStore } from "react"
import type { EntryKind, Orchestrator, Pane, PaneStatus, Target } from "./orchestrator.ts"

// Below this width, three side-by-side columns are too narrow to read.
const MIN_COLUMNS_WIDTH = 90

const ENTRY_COLORS: Record<EntryKind, string> = {
  user: "#7DCFFF",
  assistant: "#E6E6E6",
  tool: "#8A8F98",
  error: "#FF7A7A",
  info: "#8A8F98",
}

const STATUS_COLORS: Record<PaneStatus, string> = {
  idle: "#5A5F68",
  running: "#E0AF68",
  done: "#9ECE6A",
  failed: "#FF7A7A",
  cancelled: "#8A8F98",
}

const ACTIVE_BORDER = "#7DCFFF"
const MUTED = "#8A8F98"
const EDIT_MODE = "#E0AF68"

function ProviderPane({ pane, active }: { pane: Pane; active: boolean }) {
  const status = pane.available ? pane.status : "not installed"
  const borderColor = active
    ? ACTIVE_BORDER
    : pane.available
      ? STATUS_COLORS[pane.status]
      : STATUS_COLORS.failed

  return (
    <box flexGrow={1} flexBasis={0} border borderColor={borderColor} title={` ${pane.label} · ${status} `}>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {pane.entries.map((entry) => (
          <box key={entry.id} marginBottom={entry.kind === "tool" ? 0 : 1}>
            <text fg={ENTRY_COLORS[entry.kind]}>
              {entry.kind === "user" ? `> ${entry.text}` : entry.text}
            </text>
          </box>
        ))}
      </scrollbox>
    </box>
  )
}

export function App({ orchestrator }: { orchestrator: Orchestrator }) {
  const state = useSyncExternalStore(orchestrator.subscribe, orchestrator.getState)
  const { width } = useTerminalDimensions()
  const [target, setTarget] = useState<Target>("all")
  // The renderable owns the text: Enter can arrive before React has seen the
  // latest keystrokes, so a controlled value could fail to clear.
  const input = useRef<InputRenderable>(null)

  const targets: Target[] = ["all", ...state.panes.map((pane) => pane.id)]

  useKeyboard((key) => {
    if (key.name === "tab") {
      const step = key.shift ? targets.length - 1 : 1
      setTarget((current) => targets[(targets.indexOf(current) + step) % targets.length] ?? "all")
    } else if (key.name === "escape") {
      orchestrator.cancel(target)
    } else if (key.ctrl && key.name === "e") {
      orchestrator.toggleMode()
    }
  })

  const targetLabel =
    target === "all" ? "All" : state.panes.find((pane) => pane.id === target)?.label

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection={width < MIN_COLUMNS_WIDTH ? "column" : "row"} flexGrow={1}>
        {state.panes.map((pane) => (
          <ProviderPane key={pane.id} pane={pane} active={target === "all" || target === pane.id} />
        ))}
      </box>
      <box border borderColor={ACTIVE_BORDER} title={` To: ${targetLabel} `} height={3}>
        <input
          ref={input}
          focused
          placeholder="Send a prompt…"
          onSubmit={() => {
            if (!input.current) return
            orchestrator.send(target, input.current.value)
            input.current.value = ""
          }}
        />
      </box>
      <box flexDirection="row" paddingLeft={1} paddingRight={1} justifyContent="space-between">
        <text fg={MUTED}>Tab target · Enter send · Esc cancel · Ctrl+E mode · Ctrl+C quit</text>
        <text fg={state.mode === "edit" ? EDIT_MODE : MUTED}>
          {state.mode === "edit" ? "EDIT" : "READ-ONLY"}
        </text>
      </box>
    </box>
  )
}
