import type { Pane } from "../orchestrator.ts"
import { ACCENT, DANGER, ENTRY_COLORS } from "./theme.ts"

// Below this width, side-by-side columns are too narrow to read.
const MIN_COLUMNS_WIDTH = 60

function AgentPane({ pane }: { pane: Pane }) {
  const status = pane.available ? pane.status : "not installed"
  const borderColor = !pane.available || pane.status === "failed" ? DANGER : ACCENT
  const engine = pane.model ? `${pane.provider}/${pane.model}` : pane.provider
  const title = pane.label.toLowerCase() === pane.provider ? pane.label : `${pane.label} · ${engine}`

  return (
    <box flexGrow={1} flexBasis={0} border borderColor={borderColor} title={` ${title} · ${status} `}>
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

/** Shows the selected agent, or a column per agent when sending to all of them. */
export function Conversation({ panes, width }: { panes: Pane[]; width: number }) {
  return (
    <box flexDirection={width < MIN_COLUMNS_WIDTH ? "column" : "row"} flexGrow={1}>
      {panes.map((pane) => (
        <AgentPane key={pane.id} pane={pane} />
      ))}
    </box>
  )
}
