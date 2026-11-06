import type { InputRenderable, TextareaRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { slugify } from "../agents/identity.ts"
import type { Skill } from "../agents/skills.ts"
import { AGENT_TEMPLATES } from "../agents/templates.ts"
import { modeForTools, type Agent, type AgentDefinition, type SavableOrigin } from "../agents/types.ts"
import type { ListModels } from "../providers/models.ts"
import { TOOL_IDS, type ProviderId, type ToolId } from "../providers/types.ts"
import { useKeys } from "./keys.ts"
import { ACCENT, DANGER, FIELD_BACKGROUND, FIELD_FOCUSED_BACKGROUND, fit, MUTED, TEXT, TOOL_LABELS } from "./theme.ts"

const LABEL_WIDTH = 14
const INSTRUCTIONS_HEIGHT = 5
// Every line of the screen other than the open list, including an error.
const FIXED_LINES = 15 + INSTRUCTIONS_HEIGHT
const MIN_LIST_LINES = 3
const MAX_LIST_LINES = 8
const ORIGINS: SavableOrigin[] = ["global", "project"]
const ORIGIN_LABELS: Record<SavableOrigin, string> = { global: "global", project: "this project" }

type Field = "template" | "name" | "description" | "provider" | "model" | "skills" | "tools" | "instructions" | "origin"
type Catalog = { status: "loading" } | { status: "ready"; models: string[] } | { status: "failed" }
interface ModelOption {
  label: string
  /** What the model field gets. Empty means the CLI's default. */
  value: string
}

const DEFAULT_OPTION: ModelOption = { label: "CLI default", value: "" }

function cycle<T>(values: readonly T[], current: T, step: number): T {
  const position = values.indexOf(current)
  return values[(position + step + values.length) % values.length] ?? current
}

function buildOptions(models: string[], query: string, filtering: boolean): ModelOption[] {
  const toOption = (model: string): ModelOption => ({ label: model, value: model })
  if (!filtering) {
    const known = !query || models.includes(query)
    return [DEFAULT_OPTION, ...(known ? [] : [toOption(query)]), ...models.map(toOption)]
  }
  const search = query.trim().toLowerCase()
  const matches = models.filter((model) => model.toLowerCase().includes(search)).map(toOption)
  if (!search) return [DEFAULT_OPTION, ...matches]
  // The list can be incomplete, or missing if the command failed, so any name is allowed.
  const exact = models.some((model) => model.toLowerCase() === search)
  return [...matches, ...(exact ? [] : [{ label: `Use "${query.trim()}"`, value: query.trim() }])]
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

/** A window over a long list, with the position to show that it continues. */
function ListWindow({ count, cursor, lines, children }: {
  count: number
  cursor: number
  lines: number
  children: (start: number, end: number) => React.ReactNode
}) {
  const overflows = count > lines
  const visible = overflows ? lines - 1 : lines
  const start = Math.max(0, Math.min(cursor, count - visible))
  return (
    <box flexDirection="column" paddingLeft={LABEL_WIDTH} flexShrink={0}>
      {children(start, start + visible)}
      {overflows && <text fg={MUTED}>{`${cursor + 1}/${count}`}</text>}
    </box>
  )
}

export interface AgentFormProps {
  /** The agent to edit, or undefined to create one. */
  agent?: Agent
  providerIds: ProviderId[]
  lockedTools: (provider: ProviderId) => ToolId[]
  listModels: ListModels
  listSkills: () => Skill[]
  /** Returns an error message if the agent can't be saved. */
  onSave: (definition: AgentDefinition, origin: SavableOrigin) => string | undefined
  onCancel: () => void
}

export function AgentForm({ agent, providerIds, lockedTools, listModels, listSkills, onSave, onCancel }: AgentFormProps) {
  const { height, width } = useTerminalDimensions()
  const isNew = agent === undefined
  const fields: Field[] = [
    ...(isNew ? (["template"] as const) : []),
    "name",
    "description",
    "provider",
    "model",
    "skills",
    "tools",
    "instructions",
    "origin",
  ]

  const [focus, setFocus] = useState<Field>(fields[0] ?? "name")
  const [templateIndex, setTemplateIndex] = useState(0)
  const [provider, setProvider] = useState<ProviderId>(agent?.provider ?? providerIds[0] ?? "claude")
  const [origin, setOrigin] = useState<SavableOrigin>(agent?.origin === "project" ? "project" : "global")
  const [error, setError] = useState<string>()

  const [catalog, setCatalog] = useState<Catalog>({ status: "loading" })
  const [modelQuery, setModelQuery] = useState(agent?.model ?? "")
  const [filtering, setFiltering] = useState(false)
  const [modelCursor, setModelCursor] = useState(0)

  // New agents can't change anything until someone chooses otherwise.
  const [tools, setTools] = useState<ToolId[]>(
    agent?.tools ?? (agent ? (agent.mode === "edit" ? [...TOOL_IDS] : []) : []),
  )
  const [toolsTouched, setToolsTouched] = useState(false)
  const [toolCursor, setToolCursor] = useState(0)

  const availableSkills = useMemo(listSkills, [listSkills])
  const [skills, setSkills] = useState<string[]>(agent?.skills ?? [])
  const [skillsTouched, setSkillsTouched] = useState(false)
  const [skillQuery, setSkillQuery] = useState("")
  const [skillCursor, setSkillCursor] = useState(0)

  // These renderables own their text, so a template change remounts them with new content.
  const name = useRef<InputRenderable>(null)
  const description = useRef<InputRenderable>(null)
  const model = useRef<InputRenderable>(null)
  const skillFilter = useRef<InputRenderable>(null)
  const instructions = useRef<TextareaRenderable>(null)
  // Setting the field from the list also fires its input event, which isn't the user typing.
  const programmaticValue = useRef<string | undefined>(undefined)

  const template = AGENT_TEMPLATES[templateIndex]
  const initial = agent ?? template
  const locked = lockedTools(provider)
  const selectableTools = TOOL_IDS.filter((tool) => !locked.includes(tool))
  const moveFocus = (step: number) => setFocus((current) => cycle(fields, current, step))

  useEffect(() => {
    let current = true
    setCatalog({ status: "loading" })
    listModels(provider).then(
      (models) => {
        if (current) setCatalog({ status: "ready", models })
      },
      () => {
        if (current) setCatalog({ status: "failed" })
      },
    )
    return () => {
      current = false
    }
  }, [provider, listModels])

  const modelOptions = useMemo(
    () => buildOptions(catalog.status === "ready" ? catalog.models : [], modelQuery, filtering),
    [catalog, modelQuery, filtering],
  )

  // Without a filter, the list opens on the agent's current model.
  useEffect(() => {
    setModelCursor(filtering ? 0 : Math.max(0, modelOptions.findIndex((option) => option.value === modelQuery)))
  }, [modelOptions, filtering, modelQuery])

  const skillOptions = useMemo(() => {
    const search = skillQuery.trim().toLowerCase()
    const matches = search
      ? availableSkills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(search))
      : availableSkills
    // Chosen ones go first, so that they're easy to review. Missing ones stay removable.
    const known = new Set(availableSkills.map((skill) => skill.name))
    const gone = skills.filter((skill) => !known.has(skill)).map((skill) => ({ name: skill, description: "not found", path: "" }))
    return [...gone, ...matches].sort((a, b) => Number(skills.includes(b.name)) - Number(skills.includes(a.name)))
    // Re-sorting while toggling would move the row out from under the cursor.
  }, [availableSkills, skillQuery])

  useEffect(() => setSkillCursor(0), [skillQuery])

  const setModelField = (value: string) => {
    programmaticValue.current = value
    if (model.current) model.current.value = value
    setModelQuery(value)
    setFiltering(false)
  }

  const changeProvider = (step: number) => {
    setProvider((current) => cycle(providerIds, current, step))
    // One provider's model means nothing to another.
    setModelField("")
    setToolCursor(0)
  }

  const changeTemplate = (step: number) => {
    const next = (templateIndex + step + AGENT_TEMPLATES.length) % AGENT_TEMPLATES.length
    setTemplateIndex(next)
    setTools(AGENT_TEMPLATES[next]?.tools ?? [])
  }

  const toggleTool = () => {
    const tool = selectableTools[toolCursor]
    if (!tool) return
    setToolsTouched(true)
    setTools((current) => (current.includes(tool) ? current.filter((other) => other !== tool) : [...current, tool]))
  }

  const toggleSkill = () => {
    const skill = skillOptions[skillCursor]?.name
    if (!skill) return
    setSkillsTouched(true)
    setSkills((current) => (current.includes(skill) ? current.filter((other) => other !== skill) : [...current, skill]))
  }

  const save = () => {
    const nameValue = name.current?.value.trim() ?? ""
    const modelValue = model.current?.value.trim()
    // An agent that never chose keeps what its CLI gives it by default.
    const keepsToolDefaults = agent !== undefined && agent.tools === undefined && !toolsTouched
    const keepsSkillDefaults = agent !== undefined && agent.skills === undefined && !skillsTouched
    const chosenTools = TOOL_IDS.filter((tool) => tools.includes(tool) && !locked.includes(tool))
    const definition: AgentDefinition = {
      id: agent?.id ?? slugify(nameValue),
      name: nameValue,
      description: description.current?.value.trim() ?? "",
      provider,
      ...(modelValue ? { model: modelValue } : {}),
      instructions: instructions.current?.plainText.trim() ?? "",
      mode: keepsToolDefaults ? agent.mode : modeForTools(chosenTools),
      ...(keepsToolDefaults ? {} : { tools: chosenTools }),
      ...(keepsSkillDefaults ? {} : { skills }),
    }
    setError(onSave(definition, origin))
  }

  useKeys((key) => {
    if (key.ctrl && key.name === "s") {
      save()
    } else if (key.name === "escape") {
      onCancel()
    } else if (key.name === "tab") {
      moveFocus(key.shift ? -1 : 1)
    } else if (key.name === "left" || key.name === "right") {
      const step = key.name === "left" ? -1 : 1
      if (focus === "template") changeTemplate(step)
      else if (focus === "provider") changeProvider(step)
      else if (focus === "origin") setOrigin((current) => cycle(ORIGINS, current, step))
    } else if (key.name === "up" || key.name === "down") {
      const step = key.name === "up" ? -1 : 1
      if (focus === "model" && modelOptions.length > 0) {
        setModelCursor((current) => (current + step + modelOptions.length) % modelOptions.length)
      } else if (focus === "skills" && skillOptions.length > 0) {
        setSkillCursor((current) => (current + step + skillOptions.length) % skillOptions.length)
      } else if (focus === "tools" && selectableTools.length > 0) {
        setToolCursor((current) => (current + step + selectableTools.length) % selectableTools.length)
      }
    } else if (focus === "tools" && (key.name === "space" || key.name === "return" || key.name === "enter")) {
      toggleTool()
    }
  })

  const listLines = Math.min(MAX_LIST_LINES, Math.max(MIN_LIST_LINES, height - FIXED_LINES))
  const rowWidth = Math.max(10, width - LABEL_WIDTH - 8)

  const hints: Partial<Record<Field, string>> = {
    model: "Type to filter · ↑/↓ choose · Enter confirm",
    skills: "Type to filter · ↑/↓ move · Enter toggle",
    tools: "↑/↓ move · Space toggle",
  }

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={ACCENT} flexShrink={0}>
        {isNew ? "New agent" : `Edit ${agent.name}`}
      </text>
      <box height={1} flexShrink={0} />
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
          placeholder="What the orchestrator should assign to it"
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
          placeholder="CLI default · type to search"
          focused={focus === "model"}
          onInput={(value) => {
            if (value === programmaticValue.current) return
            programmaticValue.current = undefined
            setModelQuery(value)
            setFiltering(true)
          }}
          onSubmit={() => {
            const option = modelOptions[modelCursor]
            if (option) setModelField(option.value)
            moveFocus(1)
          }}
        />
      </Row>
      {focus === "model" && (
        <ListWindow count={modelOptions.length} cursor={modelCursor} lines={listLines}>
          {(start, end) => (
            <>
              {catalog.status === "loading" && <text fg={MUTED}>Loading models…</text>}
              {catalog.status === "failed" && <text fg={MUTED}>Couldn't read the model list. Type a name instead.</text>}
              {modelOptions.slice(start, end).map((option, position) => {
                const selected = start + position === modelCursor
                return (
                  <text key={option.label} fg={selected ? ACCENT : TEXT} wrapMode="none">
                    {`${selected ? "▸" : " "} ${fit(option.label, rowWidth)}`}
                  </text>
                )
              })}
            </>
          )}
        </ListWindow>
      )}
      <Row label="Skills" focused={focus === "skills"}>
        {focus === "skills" ? (
          <input
            ref={skillFilter}
            flexGrow={1}
            placeholder={availableSkills.length ? `Search ${availableSkills.length} skills` : "No skills found"}
            focused
            onInput={setSkillQuery}
            onSubmit={toggleSkill}
          />
        ) : (
          <text fg={TEXT} wrapMode="none">
            {fit(
              skills.length
                ? skills.join(", ")
                : agent && agent.skills === undefined && !skillsTouched
                  ? "What its CLI finds"
                  : "None",
              rowWidth,
            )}
          </text>
        )}
      </Row>
      {focus === "skills" && (
        <ListWindow count={skillOptions.length} cursor={skillCursor} lines={listLines}>
          {(start, end) =>
            skillOptions.slice(start, end).map((skill, position) => {
              const selected = start + position === skillCursor
              const box = skills.includes(skill.name) ? "[x]" : "[ ]"
              return (
                <text key={skill.name} fg={selected ? ACCENT : TEXT} wrapMode="none">
                  {`${selected ? "▸" : " "} ${box} ${fit(`${skill.name} · ${skill.description}`, rowWidth)}`}
                </text>
              )
            })
          }
        </ListWindow>
      )}
      <Row label="Tools" focused={focus === "tools"}>
        {focus === "tools" ? (
          <text fg={MUTED}>Reading the project is always allowed</text>
        ) : (
          <text fg={TEXT} wrapMode="none">
            {fit(
              ["read", ...TOOL_IDS.filter((tool) => tools.includes(tool) && !locked.includes(tool))].join(", "),
              rowWidth,
            )}
          </text>
        )}
      </Row>
      {focus === "tools" && (
        <box flexDirection="column" paddingLeft={LABEL_WIDTH} flexShrink={0}>
          {TOOL_IDS.map((tool) => {
            if (locked.includes(tool)) {
              return (
                <text key={tool} fg={MUTED} wrapMode="none">
                  {`  [x] ${TOOL_LABELS[tool]} (always on in ${provider}, within its sandbox)`}
                </text>
              )
            }
            const selected = selectableTools[toolCursor] === tool
            return (
              <text key={tool} fg={selected ? ACCENT : TEXT} wrapMode="none">
                {`${selected ? "▸" : " "} ${tools.includes(tool) ? "[x]" : "[ ]"} ${TOOL_LABELS[tool]}`}
              </text>
            )
          })}
        </box>
      )}
      <Row label="Instructions" focused={focus === "instructions"}>
        <textarea
          key={`instructions-${templateIndex}`}
          ref={instructions}
          flexGrow={1}
          // Without this, the text's width sets the field's width and overflows the form.
          flexBasis={0}
          height={INSTRUCTIONS_HEIGHT}
          backgroundColor={FIELD_BACKGROUND}
          focusedBackgroundColor={FIELD_FOCUSED_BACKGROUND}
          initialValue={initial?.instructions ?? ""}
          placeholder="How this agent should work"
          focused={focus === "instructions"}
        />
      </Row>
      <Row label="Save to" focused={focus === "origin"}>
        <Choice value={ORIGIN_LABELS[origin]} focused={focus === "origin"} />
      </Row>
      {error && <text fg={DANGER}>{error}</text>}
      <box flexGrow={1} />
      <text fg={MUTED} wrapMode="none" flexShrink={0}>
        {`${hints[focus] ?? "←/→ change"} · Tab next · Ctrl+S save · Esc cancel`}
      </text>
    </box>
  )
}
