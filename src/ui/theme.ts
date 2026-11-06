import type { EntryKind, PaneStatus } from "../core/agent-pool.ts"
import type { TaskStatus } from "../core/board.ts"
import type { ToolId } from "../providers/types.ts"

export const ACCENT = "#7DCFFF"
export const MUTED = "#8A8F98"
export const TEXT = "#E6E6E6"
export const WARNING = "#E0AF68"
export const DANGER = "#FF7A7A"
export const SUCCESS = "#9ECE6A"

export const ENTRY_COLORS: Record<EntryKind, string> = {
  user: ACCENT,
  assistant: TEXT,
  tool: MUTED,
  error: DANGER,
  info: MUTED,
}

export const PANE_STATUS_LABELS: Record<PaneStatus, string> = {
  idle: "idle",
  running: "working",
  done: "ready",
  failed: "failed",
  cancelled: "cancelled",
}

export const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  proposed: ACCENT,
  todo: TEXT,
  running: WARNING,
  review: WARNING,
  blocked: DANGER,
  done: SUCCESS,
  failed: DANGER,
  cancelled: MUTED,
}

export const TASK_STATUS_ICONS: Record<TaskStatus, string> = {
  proposed: "○",
  todo: " ",
  running: "●",
  review: "◎",
  blocked: "!",
  done: "✓",
  failed: "✗",
  cancelled: "–",
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  proposed: "proposed",
  todo: "to do",
  running: "running",
  review: "in review",
  blocked: "blocked",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
}

export const TOOL_LABELS: Record<ToolId, string> = {
  edit: "Edit files",
  shell: "Run commands",
  web: "Search the web",
  mcp: "MCP servers",
}

/** Cuts a text to one line of this width, padding it if asked. */
export function fit(text: string, width: number, pad = false): string {
  const line = text.replace(/\s+/g, " ").trim()
  const cut = line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line
  return pad ? cut.padEnd(width) : cut
}
