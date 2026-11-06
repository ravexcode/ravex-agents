import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useRef } from "react"
import type { Entry } from "../core/agent-pool.ts"
import type { Task } from "../core/board.ts"
import { Entries, HIDDEN_SCROLLBAR } from "./conversation.tsx"
import { Prompt } from "./prompt.tsx"
import { ACCENT, MUTED, TASK_STATUS_COLORS, TASK_STATUS_LABELS, TEXT } from "./theme.ts"

const PAGE_LINES = 10

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <text fg={ACCENT}>{title}</text>
      {children}
    </box>
  )
}

function authorLabel(author: string, nameOf: (id: string) => string): string {
  if (author === "you") return "You"
  if (author === "system") return "System"
  return nameOf(author)
}

export interface TaskDetailProps {
  task: Task
  entries: Entry[]
  nameOf: (id: string) => string
  onComment: (text: string) => void
  onClose: () => void
}

export function TaskDetail({ task, entries, nameOf, onComment, onClose }: TaskDetailProps) {
  const input = useRef<InputRenderable>(null)
  const scroll = useRef<ScrollBoxRenderable>(null)

  useKeyboard((key) => {
    if (key.name === "escape") onClose()
    else if (key.name === "pageup") scroll.current?.scrollBy(-PAGE_LINES)
    else if (key.name === "pagedown") scroll.current?.scrollBy(PAGE_LINES)
  })

  const facts = [
    `Assigned to ${nameOf(task.assignee)}`,
    task.edits ? "edits files" : "read-only",
    ...(task.reviewer ? [`reviewer ${nameOf(task.reviewer)}`] : []),
    ...(task.dependsOn.length ? [`depends on ${task.dependsOn.join(", ")}`] : []),
  ].join(" · ")

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <text fg={TASK_STATUS_COLORS[task.status]} flexShrink={0}>
        {`Task ${task.id} · ${TASK_STATUS_LABELS[task.status]}`}
      </text>
      <scrollbox ref={scroll} flexGrow={1} flexBasis={0} marginTop={1} verticalScrollbarOptions={HIDDEN_SCROLLBAR}>
        <Section title={task.title}>
          <text fg={MUTED}>{facts}</text>
          <text fg={TEXT}>{task.description}</text>
        </Section>
        {task.result && (
          <Section title="Result">
            <text fg={TEXT}>{task.result}</text>
          </Section>
        )}
        {task.comments.length > 0 && (
          <Section title="Comments">
            {task.comments.map((comment, position) => (
              <text key={position} fg={TEXT}>{`${authorLabel(comment.author, nameOf)}: ${comment.text}`}</text>
            ))}
          </Section>
        )}
        {entries.length > 0 && (
          <Section title="Agent conversation">
            <Entries entries={entries} />
          </Section>
        )}
      </scrollbox>
      <Prompt
        inputRef={input}
        focused
        placeholder="Comment on this task. The agent sees it on its next turn…"
        onSubmit={() => {
          if (!input.current) return
          onComment(input.current.value)
          input.current.value = ""
        }}
      />
      <text fg={MUTED} wrapMode="none" flexShrink={0}>
        Enter comment · PgUp/PgDn scroll · Esc back
      </text>
    </box>
  )
}
