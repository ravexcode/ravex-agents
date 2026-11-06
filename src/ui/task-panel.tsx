import type { Board, Task } from "../core/board.ts"
import { ACCENT, fit, MUTED, TASK_STATUS_COLORS, TASK_STATUS_ICONS } from "./theme.ts"

export const TASK_PANEL_WIDTH = 38
const INNER_WIDTH = TASK_PANEL_WIDTH - 2
const ASSIGNEE_WIDTH = 10
// The cursor, the icon, the number and their spaces.
const PREFIX_WIDTH = 6

interface Line {
  taskIndex: number
  text: string
  color: string
}

function detailLine(task: Task, board: Board): string {
  const parts: string[] = []
  if (board.pendingRetry.includes(task.id)) parts.push("↻ se reintenta")
  if (task.status === "proposed" && task.edits) parts.push("edita")
  if (task.status === "proposed" && task.reviewer) parts.push(`revisa ${task.reviewer}`)
  if (task.status === "review" && task.reviewer) parts.push(`revisa ${task.reviewer}`)

  if (task.status === "todo" || task.status === "proposed") {
    const unfinished = task.dependsOn.filter((id) => board.tasks.find((other) => other.id === id)?.status !== "done")
    if (unfinished.length > 0) parts.push(`← espera a ${unfinished.join(", ")}`)
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
  /** Takes the panel's place when there's no room for both side by side. */
  grow?: boolean
}

export function TaskPanel({ board, cursor, focused, height, nameOf, grow }: TaskPanelProps) {
  const lines = buildLines(board, cursor, focused, nameOf)
  const visible = Math.max(1, height - 2)
  const cursorLine = lines.findIndex((line) => line.taskIndex === cursor)
  const start = Math.max(0, Math.min(cursorLine, lines.length - visible))

  return (
    <box
      {...(grow ? { flexGrow: 1 } : { width: TASK_PANEL_WIDTH })}
      flexShrink={0}
      border
      borderColor={focused ? ACCENT : MUTED}
      title=" Tareas "
      flexDirection="column"
    >
      {lines.length === 0 && <text fg={MUTED}> Sin tareas todavía</text>}
      {lines.slice(start, start + visible).map((line, position) => (
        <text key={`${line.taskIndex}-${position}`} fg={line.color} wrapMode="none">
          {line.text}
        </text>
      ))}
    </box>
  )
}
