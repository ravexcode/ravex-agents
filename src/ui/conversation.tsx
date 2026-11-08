import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import type { RefObject } from "react"
import type { Entry, Pane } from "../core/agent-pool.ts"
import type { RoomMessage } from "../core/room.ts"
import { Spinner } from "./spinner.tsx"
import { ACCENT, BACKGROUND, DANGER, ENTRY_COLORS, MUTED, PANE_STATUS_LABELS, TEXT } from "./theme.ts"

// PageUp and PageDown scroll instead, which leaves the screen free of chrome.
export const HIDDEN_SCROLLBAR = { visible: false }

// The block an agent is still writing for the team, which it removes once it's parsed.
const LIVE_BLOCK = /```ravex-[\s\S]*$/

const ENTRY_PREFIXES: Partial<Record<Entry["kind"], string>> = { user: "> ", thinking: "✻ ", tool: "◆ " }

export interface EntriesProps {
  entries: Entry[]
  /** The last entry may still be arriving. */
  live?: boolean
}

export function Entries({ entries, live }: EntriesProps) {
  const last = entries.at(-1)
  return (
    <>
      {entries.map((entry) => {
        const streaming = live && entry === last && entry.kind === "assistant"
        const text = (streaming ? entry.text.replace(LIVE_BLOCK, "") : entry.text).trimEnd()
        if (!text) return null
        return (
          // Solid, because the logo behind would otherwise show between the words.
          <box key={entry.id} paddingBottom={entry.kind === "tool" ? 0 : 1} backgroundColor={BACKGROUND} flexShrink={0}>
            <text
              fg={ENTRY_COLORS[entry.kind]}
              attributes={entry.kind === "thinking" ? TextAttributes.ITALIC : TextAttributes.NONE}
            >
              {`${ENTRY_PREFIXES[entry.kind] ?? ""}${text}`}
            </text>
          </box>
        )
      })}
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
  const model = pane.model ? `${pane.provider}/${pane.model}` : pane.provider
  const engine = pane.effort ? `${model} · ${pane.effort}` : model

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
        <Entries
          entries={hideRoom ? pane.entries.filter((entry) => !entry.room) : pane.entries}
          live={pane.status === "running"}
        />
      </scrollbox>
      {pane.status === "running" && <Spinner label={pane.activity ?? "Working"} />}
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
  /** What the agent replying has written so far. */
  liveReply?: string
  nameOf: (id: string) => string
  scrollRef: RefObject<ScrollBoxRenderable | null>
}

export function RoomPanel({ messages, busy, liveReply, nameOf, scrollRef }: RoomPanelProps) {
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
          <box key={message.id} paddingBottom={message.kind === "info" ? 0 : 1} backgroundColor={BACKGROUND} flexShrink={0}>
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
        {busy && liveReply && (
          <box backgroundColor={BACKGROUND} flexShrink={0}>
            <text fg={TEXT}>{`${nameOf(busy)}: ${liveReply}`}</text>
          </box>
        )}
      </scrollbox>
      {busy && <Spinner label={`${nameOf(busy)} is replying`} />}
    </box>
  )
}
