import type { Board, Task } from "../core/board.ts"
import { ACCENT, BACKGROUND, fit, MUTED, TASK_STATUS_COLORS, TASK_STATUS_ICONS } from "./theme.ts"

const INNER_WIDTH = 36
const GUTTER = 2
export const TASK_PANEL_WIDTH = INNER_WIDTH + GUTTER
const ASSIGNEE_WIDTH = 10
// The cursor, the icon, the number and their spaces.
const PREFIX_WIDTH = 6
// The panel's heading and the space under it.
const HEADING_LINES = 2

interface Line {
  taskIndex: number
  text: string
  color: string
}

function detailLine(task: Task, board: Board): string {
  const parts: string[] = []
  if (board.pendingRetry.includes(task.id)) parts.push("↻ retry")
  if (task.status === "proposed" && task.edits) parts.push("edits")
  if ((task.status === "proposed" || task.status === "review") && task.reviewer) {
    parts.push(`reviewer ${task.reviewer}`)
  }
  if (task.status === "todo" || task.status === "proposed") {
    const unfinished = task.dependsOn.filter((id) => board.tasks.find((other) => other.id === id)?.status !== "done")
    if (unfinished.length > 0) parts.push(`← waits for ${unfinished.join(", ")}`)
  }
  return parts.join(" · ")
}

function buildLines(board: Board, cursor: number, focused: boolean, nameOf: (id: string) => string): Line[] {
  return board.tasks.flatMap((task, taskIndex) => {
    const selected = focused && taskIndex === cursor
    const titleWidth = INNER_WIDTH - PREFIX_WIDTH - ASSIGNEE_WIDTH - 1
    const main = `${selected ? "▸" : " "}${TASK_STATUS_ICONS[task.status]} ${String(task.id).padStart(2)} ${fit(task.title, titleWidth, true)} ${fit(nameOf(task.assignee), ASSIGNEE_WIDTH)}`
    const detail = detailLine(task, board)
    return [
      { taskIndex, text: main, color: selected ? ACCENT : TASK_STATUS_COLORS[task.status] },
      ...(detail ? [{ taskIndex, text: `      ${fit(detail, INNER_WIDTH - PREFIX_WIDTH)}`, color: MUTED }] : []),
    ]
  })
}

export interface TaskPanelProps {
  board: Board
  cursor: number
  focused: boolean
  height: number
  nameOf: (id: string) => string
  /** Takes the conversation's place when there's no room for both side by side. */
  grow?: boolean
}

export function TaskPanel({ board, cursor, focused, height, nameOf, grow }: TaskPanelProps) {
  const lines = buildLines(board, cursor, focused, nameOf)
  const visible = Math.max(1, height - HEADING_LINES)
  const cursorLine = lines.findIndex((line) => line.taskIndex === cursor)
  const start = Math.max(0, Math.min(cursorLine, lines.length - visible))

  return (
    <box
      {...(grow ? { flexGrow: 1 } : { width: TASK_PANEL_WIDTH, paddingLeft: GUTTER })}
      flexShrink={0}
      flexDirection="column"
      backgroundColor={BACKGROUND}
    >
      <box height={HEADING_LINES} flexShrink={0}>
        <text fg={focused ? ACCENT : MUTED}>Tasks</text>
      </box>
      {lines.slice(start, start + visible).map((line, position) => (
        <text key={`${line.taskIndex}-${position}`} fg={line.color} wrapMode="none">
          {line.text}
        </text>
      ))}
    </box>
  )
}
