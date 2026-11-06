import type { ScrollBoxRenderable } from "@opentui/core"
import type { RefObject } from "react"
import type { Entry, Pane } from "../core/agent-pool.ts"
import type { RoomMessage } from "../core/room.ts"
import { DANGER, ACCENT, ENTRY_COLORS, MUTED, PANE_STATUS_LABELS, TEXT } from "./theme.ts"

// PageUp and PageDown scroll instead, which leaves the screen free of chrome.
export const HIDDEN_SCROLLBAR = { visible: false }

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

export interface ChatPanelProps {
  pane: Pane
  hideRoom?: boolean
  scrollRef: RefObject<ScrollBoxRenderable | null>
}

/** A conversation with the orchestrator or with one agent. */
export function ChatPanel({ pane, hideRoom, scrollRef }: ChatPanelProps) {
  const status = pane.available ? PANE_STATUS_LABELS[pane.status] : "not installed"
  const engine = pane.model ? `${pane.provider}/${pane.model}` : pane.provider

  return (
    <box flexGrow={1} flexBasis={0} flexDirection="column">
      <text fg={!pane.available || pane.status === "failed" ? DANGER : MUTED} wrapMode="none" flexShrink={0}>
        {`${pane.label} · ${engine} · ${status}`}
      </text>
      <scrollbox
        ref={scrollRef}
        flexGrow={1}
        marginTop={1}
        stickyScroll
        stickyStart="bottom"
        verticalScrollbarOptions={HIDDEN_SCROLLBAR}
      >
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
  scrollRef: RefObject<ScrollBoxRenderable | null>
}

export function RoomPanel({ messages, busy, nameOf, scrollRef }: RoomPanelProps) {
  return (
    <box flexGrow={1} flexBasis={0} flexDirection="column">
      <text fg={MUTED} flexShrink={0}>
        Team room
      </text>
      <scrollbox
        ref={scrollRef}
        flexGrow={1}
        marginTop={1}
        stickyScroll
        stickyStart="bottom"
        verticalScrollbarOptions={HIDDEN_SCROLLBAR}
      >
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
        {busy && <text fg={MUTED}>{`${nameOf(busy)} is replying…`}</text>}
      </scrollbox>
    </box>
  )
}
