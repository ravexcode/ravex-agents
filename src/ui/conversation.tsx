import type { Entry, Pane } from "../core/agent-pool.ts"
import type { RoomMessage } from "../core/room.ts"
import { ACCENT, DANGER, ENTRY_COLORS, MUTED, PANE_STATUS_LABELS, TEXT } from "./theme.ts"

export function Entries({ entries }: { entries: Entry[] }) {
  return (
    <>
      {entries.map((entry) => (
        <box key={entry.id} marginBottom={entry.kind === "tool" ? 0 : 1} flexShrink={0}>
          <text fg={ENTRY_COLORS[entry.kind]}>{entry.kind === "user" ? `> ${entry.text}` : entry.text}</text>
        </box>
      ))}
    </>
  )
}

/** A conversation with the orchestrator or with one agent. */
export function ChatPanel({ pane, hideRoom }: { pane: Pane; hideRoom?: boolean }) {
  const status = pane.available ? PANE_STATUS_LABELS[pane.status] : "no instalado"
  const borderColor = !pane.available || pane.status === "failed" ? DANGER : ACCENT
  const engine = pane.model ? `${pane.provider}/${pane.model}` : pane.provider

  return (
    <box flexGrow={1} flexBasis={0} border borderColor={borderColor} title={` ${pane.label} · ${engine} · ${status} `}>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        <Entries entries={hideRoom ? pane.entries.filter((entry) => !entry.room) : pane.entries} />
      </scrollbox>
    </box>
  )
}

const ROOM_COLORS: Record<RoomMessage["kind"], string> = {
  user: ACCENT,
  agent: TEXT,
  info: MUTED,
  error: DANGER,
}

export interface RoomPanelProps {
  messages: RoomMessage[]
  busy?: string
  nameOf: (id: string) => string
}

export function RoomPanel({ messages, busy, nameOf }: RoomPanelProps) {
  return (
    <box flexGrow={1} flexBasis={0} border borderColor={ACCENT} title=" Sala ">
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {messages.map((message) => (
          <box key={message.id} marginBottom={message.kind === "info" ? 0 : 1} flexShrink={0}>
            <text fg={ROOM_COLORS[message.kind]}>
              {message.kind === "user"
                ? `> ${message.text}`
                : message.kind === "agent"
                  ? `${nameOf(message.author ?? "")}: ${message.text}`
                  : message.kind === "info"
                    ? `· ${message.text}`
                    : message.text}
            </text>
          </box>
        ))}
        {busy && <text fg={MUTED}>{`${nameOf(busy)} está respondiendo…`}</text>}
      </scrollbox>
    </box>
  )
}
