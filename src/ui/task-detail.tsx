import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useRef } from "react"
import type { Entry } from "../core/agent-pool.ts"
import type { Task } from "../core/board.ts"
import { Entries } from "./conversation.tsx"
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
    `Asignada a ${nameOf(task.assignee)}`,
    task.edits ? "edita archivos" : "solo lectura",
    ...(task.reviewer ? [`revisa ${nameOf(task.reviewer)}`] : []),
    ...(task.dependsOn.length ? [`depende de ${task.dependsOn.join(", ")}`] : []),
  ].join(" · ")

  return (
    <box flexDirection="column" flexGrow={1}>
      <box
        flexGrow={1}
        flexBasis={0}
        border
        borderColor={TASK_STATUS_COLORS[task.status]}
        title={` Tarea ${task.id} · ${TASK_STATUS_LABELS[task.status]} `}
      >
        <scrollbox ref={scroll} flexGrow={1}>
          <Section title={task.title}>
            <text fg={MUTED}>{facts}</text>
            <text fg={TEXT}>{task.description}</text>
          </Section>
          {task.result && (
            <Section title="Resultado">
              <text fg={TEXT}>{task.result}</text>
            </Section>
          )}
          {task.comments.length > 0 && (
            <Section title="Comentarios">
              {task.comments.map((comment, position) => (
                <text key={position} fg={TEXT}>{`${comment.author === "you" ? "Tú" : comment.author === "system" ? "Sistema" : nameOf(comment.author)}: ${comment.text}`}</text>
              ))}
            </Section>
          )}
          {entries.length > 0 && (
            <Section title="Conversación del agente">
              <Entries entries={entries} />
            </Section>
          )}
        </scrollbox>
      </box>
      <box border borderColor={ACCENT} title=" Comentar en la tarea " height={3} flexShrink={0}>
        <input
          ref={input}
          focused
          placeholder="El agente lo verá en su próximo turno…"
          onSubmit={() => {
            if (!input.current) return
            onComment(input.current.value)
            input.current.value = ""
          }}
        />
      </box>
      <text fg={MUTED}> Enter comenta · RePág/AvPág desplaza · Esc volver</text>
    </box>
  )
}
