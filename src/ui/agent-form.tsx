import type { InputRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useRef, useState } from "react"
import { slugify } from "../agents/graph.ts"
import { AGENT_TEMPLATES } from "../agents/templates.ts"
import type { Agent, AgentDefinition, SavableOrigin } from "../agents/types.ts"
import type { PermissionMode, ProviderId } from "../providers/types.ts"
import { ACCENT, DANGER, MUTED, TEXT } from "./theme.ts"

const LABEL_WIDTH = 13
const INSTRUCTIONS_HEIGHT = 5
// Every line of the screen other than the subagent list, including an error.
const FIXED_LINES = 12 + INSTRUCTIONS_HEIGHT
const MIN_SUBAGENT_LINES = 3
const MODES: PermissionMode[] = ["read-only", "edit"]
const ORIGINS: SavableOrigin[] = ["global", "project"]

const MODEL_HINTS: Record<ProviderId, string> = {
  claude: "CLI default, or sonnet, opus, haiku…",
  codex: "CLI default, or a model name",
  opencode: "CLI default, or provider/model",
}

type Field =
  | "template"
  | "name"
  | "description"
  | "provider"
  | "model"
  | "mode"
  | "origin"
  | "instructions"
  | "subagents"

function cycle<T>(values: readonly T[], current: T, step: number): T {
  const position = values.indexOf(current)
  return values[(position + step + values.length) % values.length] ?? current
}

function Row({ label, focused, children }: { label: string; focused: boolean; children: React.ReactNode }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <text width={LABEL_WIDTH} flexShrink={0} fg={focused ? ACCENT : MUTED}>
        {label}
      </text>
      {children}
    </box>
  )
}

function Choice({ value, focused }: { value: string; focused: boolean }) {
  return <text fg={focused ? ACCENT : TEXT}>{focused ? `◂ ${value} ▸` : value}</text>
}

export interface AgentFormProps {
  /** The agent to edit, or undefined to create one. */
  agent?: Agent
  agents: Agent[]
  providerIds: ProviderId[]
  /** Returns an error message if the agent can't be saved. */
  onSave: (definition: AgentDefinition, origin: SavableOrigin) => string | undefined
  onCancel: () => void
}

export function AgentForm({ agent, agents, providerIds, onSave, onCancel }: AgentFormProps) {
  const { height } = useTerminalDimensions()
  const isNew = agent === undefined
  const fields: Field[] = [
    ...(isNew ? (["template"] as const) : []),
    "name",
    "description",
    "provider",
    "model",
    "mode",
    "origin",
    "instructions",
    "subagents",
  ]

  const [focus, setFocus] = useState<Field>(fields[0] ?? "name")
  const [templateIndex, setTemplateIndex] = useState(0)
  const [provider, setProvider] = useState<ProviderId>(agent?.provider ?? providerIds[0] ?? "claude")
  // New agents can't change anything until someone chooses otherwise.
  const [mode, setMode] = useState<PermissionMode>(agent?.mode ?? "read-only")
  const [origin, setOrigin] = useState<SavableOrigin>(agent?.origin === "project" ? "project" : "global")
  const [subagents, setSubagents] = useState<string[]>(agent?.subagents ?? [])
  const [cursor, setCursor] = useState(0)
  const [error, setError] = useState<string>()

  // These renderables own their text, so a template change remounts them with new content.
  const name = useRef<InputRenderable>(null)
  const description = useRef<InputRenderable>(null)
  const model = useRef<InputRenderable>(null)
  const instructions = useRef<TextareaRenderable>(null)

  const template = AGENT_TEMPLATES[templateIndex]
  const initial = agent ?? template
  const candidates = agents.filter((candidate) => candidate.id !== agent?.id)
  const moveFocus = (step: number) => setFocus((current) => cycle(fields, current, step))

  const save = () => {
    const nameValue = name.current?.value.trim() ?? ""
    const modelValue = model.current?.value.trim()
    const definition: AgentDefinition = {
      id: agent?.id ?? slugify(nameValue),
      name: nameValue,
      description: description.current?.value.trim() ?? "",
      provider,
      ...(modelValue ? { model: modelValue } : {}),
      instructions: instructions.current?.plainText.trim() ?? "",
      mode,
      subagents,
    }
    setError(onSave(definition, origin))
  }

  useKeyboard((key) => {
    if (key.ctrl && key.name === "s") {
      save()
    } else if (key.name === "escape") {
      onCancel()
    } else if (key.name === "tab") {
      moveFocus(key.shift ? -1 : 1)
    } else if (key.name === "left" || key.name === "right") {
      const step = key.name === "left" ? -1 : 1
      if (focus === "template") {
        setTemplateIndex((current) => (current + step + AGENT_TEMPLATES.length) % AGENT_TEMPLATES.length)
      } else if (focus === "provider") {
        setProvider((current) => cycle(providerIds, current, step))
      } else if (focus === "mode") {
        setMode((current) => cycle(MODES, current, step))
      } else if (focus === "origin") {
        setOrigin((current) => cycle(ORIGINS, current, step))
      }
    } else if (focus === "subagents" && candidates.length > 0) {
      if (key.name === "up" || key.name === "down") {
        const step = key.name === "up" ? -1 : 1
        setCursor((current) => (current + step + candidates.length) % candidates.length)
      } else if (key.name === "space") {
        const id = candidates[cursor]?.id
        if (id) {
          setSubagents((current) =>
            current.includes(id) ? current.filter((other) => other !== id) : [...current, id],
          )
        }
      }
    }
  })

  const subagentLines = Math.max(MIN_SUBAGENT_LINES, height - FIXED_LINES)
  const overflows = candidates.length > subagentLines
  // One line goes to the position, which shows that the list continues.
  const visibleSubagents = overflows ? subagentLines - 1 : subagentLines
  const windowStart = Math.max(0, Math.min(cursor, candidates.length - visibleSubagents))

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      border
      borderColor={ACCENT}
      title={isNew ? " New agent " : ` Edit ${agent.name} `}
      paddingLeft={1}
      paddingRight={1}
    >
      {isNew && (
        <Row label="Template" focused={focus === "template"}>
          <Choice value={template?.label ?? ""} focused={focus === "template"} />
        </Row>
      )}
      <Row label="Name" focused={focus === "name"}>
        <input
          key={`name-${templateIndex}`}
          ref={name}
          flexGrow={1}
          value={initial?.name ?? ""}
          placeholder="Security"
          focused={focus === "name"}
          onSubmit={() => moveFocus(1)}
        />
      </Row>
      <Row label="Description" focused={focus === "description"}>
        <input
          key={`description-${templateIndex}`}
          ref={description}
          flexGrow={1}
          value={initial?.description ?? ""}
          placeholder="What parents should delegate to it"
          focused={focus === "description"}
          onSubmit={() => moveFocus(1)}
        />
      </Row>
      <Row label="Provider" focused={focus === "provider"}>
        <Choice value={provider} focused={focus === "provider"} />
      </Row>
      <Row label="Model" focused={focus === "model"}>
        <input
          ref={model}
          flexGrow={1}
          value={agent?.model ?? ""}
          placeholder={MODEL_HINTS[provider]}
          focused={focus === "model"}
          onSubmit={() => moveFocus(1)}
        />
      </Row>
      <Row label="Max mode" focused={focus === "mode"}>
        <Choice value={mode} focused={focus === "mode"} />
      </Row>
      <Row label="Save to" focused={focus === "origin"}>
        <Choice value={origin} focused={focus === "origin"} />
      </Row>
      <Row label="Instructions" focused={focus === "instructions"}>
        <textarea
          key={`instructions-${templateIndex}`}
          ref={instructions}
          flexGrow={1}
          // Without this, the text's width sets the field's width and overflows the form.
          flexBasis={0}
          height={INSTRUCTIONS_HEIGHT}
          backgroundColor="#1F2229"
          focusedBackgroundColor="#262A33"
          initialValue={initial?.instructions ?? ""}
          placeholder="How this agent should work"
          focused={focus === "instructions"}
        />
      </Row>
      <Row label="Subagents" focused={focus === "subagents"}>
        <box flexDirection="column" flexGrow={1} flexShrink={0}>
          {candidates.length === 0 && <text fg={MUTED}>No other agents yet</text>}
          {candidates.slice(windowStart, windowStart + visibleSubagents).map((candidate) => {
            const hovered = focus === "subagents" && candidates[cursor]?.id === candidate.id
            const box = subagents.includes(candidate.id) ? "[x]" : "[ ]"
            return (
              <text key={candidate.id} fg={hovered ? ACCENT : TEXT}>
                {`${box} ${candidate.name} (${candidate.provider})`}
              </text>
            )
          })}
          {overflows && <text fg={MUTED}>{`${cursor + 1}/${candidates.length}`}</text>}
        </box>
      </Row>
      {error && <text fg={DANGER}>{error}</text>}
      <text fg={MUTED}>Tab next · ←/→ change · ↑/↓ Space subagents · Ctrl+S save · Esc cancel</text>
    </box>
  )
}
