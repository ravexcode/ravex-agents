import type { EntryKind, PaneStatus } from "../orchestrator.ts"

export const ACCENT = "#7DCFFF"
export const MUTED = "#8A8F98"
export const TEXT = "#E6E6E6"
export const WARNING = "#E0AF68"
export const DANGER = "#FF7A7A"

export const ENTRY_COLORS: Record<EntryKind, string> = {
  user: ACCENT,
  assistant: TEXT,
  tool: MUTED,
  error: DANGER,
  info: MUTED,
}

export const STATUS_COLORS: Record<PaneStatus, string> = {
  idle: "#5A5F68",
  running: WARNING,
  waiting: WARNING,
  done: "#9ECE6A",
  failed: DANGER,
  cancelled: MUTED,
}

export const STATUS_ICONS: Record<PaneStatus, string> = {
  idle: " ",
  running: "●",
  waiting: "◌",
  done: "✓",
  failed: "✗",
  cancelled: "–",
}
