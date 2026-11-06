import type { InputRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { slugify } from "../agents/identity.ts"
import { AGENT_TEMPLATES } from "../agents/templates.ts"
import type { Agent, AgentDefinition, SavableOrigin } from "../agents/types.ts"
import type { ListModels } from "../providers/models.ts"
import type { PermissionMode, ProviderId } from "../providers/types.ts"
import { ACCENT, DANGER, fit, MUTED, TEXT } from "./theme.ts"

const LABEL_WIDTH = 14
const INSTRUCTIONS_HEIGHT = 5
// Every line of the screen other than the model list, including an error.
const FIXED_LINES = 12 + INSTRUCTIONS_HEIGHT
const MIN_PICKER_LINES = 3
const MAX_PICKER_LINES = 8
const MODES: PermissionMode[] = ["read-only", "edit"]
const MODE_LABELS: Record<PermissionMode, string> = { "read-only": "solo lectura", edit: "edición" }
const ORIGINS: SavableOrigin[] = ["global", "project"]
const ORIGIN_LABELS: Record<SavableOrigin, string> = { global: "global", project: "este proyecto" }

type Field = "template" | "name" | "description" | "provider" | "model" | "mode" | "origin" | "instructions"
type Catalog = { status: "loading" } | { status: "ready"; models: string[] } | { status: "failed" }
interface ModelOption {
  label: string
  /** What the model field gets. Empty means the CLI's default. */
  value: string
}

const DEFAULT_OPTION: ModelOption = { label: "Por defecto de la CLI", value: "" }

function cycle<T>(values: readonly T[], current: T, step: number): T {
  const position = values.indexOf(current)
  return values[(position + step + values.length) % values.length] ?? current
}

function buildOptions(models: string[], query: string, filtering: boolean, current: string): ModelOption[] {
  const toOption = (model: string): ModelOption => ({ label: model, value: model })
  if (!filtering) {
    const known = !current || models.includes(current)
    return [DEFAULT_OPTION, ...(known ? [] : [toOption(current)]), ...models.map(toOption)]
  }
  const search = query.trim().toLowerCase()
  const matches = models.filter((model) => model.toLowerCase().includes(search)).map(toOption)
  if (!search) return [DEFAULT_OPTION, ...matches]
  // The list can be incomplete, or missing if the command failed, so any name is allowed.
  const exact = models.some((model) => model.toLowerCase() === search)
  return [...matches, ...(exact ? [] : [{ label: `Usar "${query.trim()}"`, value: query.trim() }])]
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
  providerIds: ProviderId[]
  listModels: ListModels
  /** Returns an error message if the agent can't be saved. */
  onSave: (definition: AgentDefinition, origin: SavableOrigin) => string | undefined
  onCancel: () => void
}

export function AgentForm({ agent, providerIds, listModels, onSave, onCancel }: AgentFormProps) {
  const { height, width } = useTerminalDimensions()
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
  ]

  const [focus, setFocus] = useState<Field>(fields[0] ?? "name")
  const [templateIndex, setTemplateIndex] = useState(0)
  const [provider, setProvider] = useState<ProviderId>(agent?.provider ?? providerIds[0] ?? "claude")
  // New agents can't change anything until someone chooses otherwise.
  const [mode, setMode] = useState<PermissionMode>(agent?.mode ?? "read-only")
  const [origin, setOrigin] = useState<SavableOrigin>(agent?.origin === "project" ? "project" : "global")
  const [error, setError] = useState<string>()

  const [catalog, setCatalog] = useState<Catalog>({ status: "loading" })
  const [query, setQuery] = useState(agent?.model ?? "")
  const [filtering, setFiltering] = useState(false)
  const [pickerCursor, setPickerCursor] = useState(0)

  // These renderables own their text, so a template change remounts them with new content.
  const name = useRef<InputRenderable>(null)
  const description = useRef<InputRenderable>(null)
  const model = useRef<InputRenderable>(null)
  const instructions = useRef<TextareaRenderable>(null)
  // Setting the field from the list also fires its input event, which isn't the user typing.
  const programmaticValue = useRef<string | undefined>(undefined)

  const template = AGENT_TEMPLATES[templateIndex]
  const initial = agent ?? template
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

  const options = useMemo(
    () => buildOptions(catalog.status === "ready" ? catalog.models : [], query, filtering, query),
    [catalog, query, filtering],
  )

  // Without a filter, the list opens on the agent's current model.
  useEffect(() => {
    if (filtering) {
      setPickerCursor(0)
      return
    }
    setPickerCursor(Math.max(0, options.findIndex((option) => option.value === query)))
  }, [options, filtering, query])

  const setModelField = (value: string) => {
    programmaticValue.current = value
    if (model.current) model.current.value = value
    setQuery(value)
    setFiltering(false)
  }

  const changeProvider = (step: number) => {
    setProvider((current) => cycle(providerIds, current, step))
    // One provider's model means nothing to another.
    setModelField("")
  }

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
        changeProvider(step)
      } else if (focus === "mode") {
        setMode((current) => cycle(MODES, current, step))
      } else if (focus === "origin") {
        setOrigin((current) => cycle(ORIGINS, current, step))
      }
    } else if (focus === "model" && (key.name === "up" || key.name === "down") && options.length > 0) {
      const step = key.name === "up" ? -1 : 1
      setPickerCursor((current) => (current + step + options.length) % options.length)
    }
  })

  const pickerLines = Math.min(MAX_PICKER_LINES, Math.max(MIN_PICKER_LINES, height - FIXED_LINES))
  const overflows = options.length > pickerLines
  // One line goes to the position, which shows that the list continues.
  const visibleOptions = overflows ? pickerLines - 1 : pickerLines
  const windowStart = Math.max(0, Math.min(pickerCursor, options.length - visibleOptions))

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      border
      borderColor={ACCENT}
      title={isNew ? " Nuevo agente " : ` Editar ${agent.name} `}
      paddingLeft={1}
      paddingRight={1}
    >
      {isNew && (
        <Row label="Plantilla" focused={focus === "template"}>
          <Choice value={template?.label ?? ""} focused={focus === "template"} />
        </Row>
      )}
      <Row label="Nombre" focused={focus === "name"}>
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
      <Row label="Descripción" focused={focus === "description"}>
        <input
          key={`description-${templateIndex}`}
          ref={description}
          flexGrow={1}
          value={initial?.description ?? ""}
          placeholder="Qué debería asignarle el orquestador"
          focused={focus === "description"}
          onSubmit={() => moveFocus(1)}
        />
      </Row>
      <Row label="Proveedor" focused={focus === "provider"}>
        <Choice value={provider} focused={focus === "provider"} />
      </Row>
      <Row label="Modelo" focused={focus === "model"}>
        <input
          ref={model}
          flexGrow={1}
          value={agent?.model ?? ""}
          placeholder="Por defecto de la CLI · escribe para buscar"
          focused={focus === "model"}
          onInput={(value) => {
            if (value === programmaticValue.current) return
            programmaticValue.current = undefined
            setQuery(value)
            setFiltering(true)
          }}
          onSubmit={() => {
            const option = options[pickerCursor]
            if (option) setModelField(option.value)
            moveFocus(1)
          }}
        />
      </Row>
      {focus === "model" && (
        <box flexDirection="column" paddingLeft={LABEL_WIDTH} flexShrink={0}>
          {catalog.status === "loading" && <text fg={MUTED}>Cargando modelos…</text>}
          {catalog.status === "failed" && (
            <text fg={MUTED}>No se pudo leer la lista de modelos. Escribe el nombre a mano.</text>
          )}
          {options.slice(windowStart, windowStart + visibleOptions).map((option, position) => {
            const selected = windowStart + position === pickerCursor
            return (
              <text key={option.label} fg={selected ? ACCENT : TEXT} wrapMode="none">
                {`${selected ? "▸" : " "} ${fit(option.label, Math.max(10, width - LABEL_WIDTH - 8))}`}
              </text>
            )
          })}
          {overflows && <text fg={MUTED}>{`${pickerCursor + 1}/${options.length}`}</text>}
        </box>
      )}
      <Row label="Modo máximo" focused={focus === "mode"}>
        <Choice value={MODE_LABELS[mode]} focused={focus === "mode"} />
      </Row>
      <Row label="Guardar en" focused={focus === "origin"}>
        <Choice value={ORIGIN_LABELS[origin]} focused={focus === "origin"} />
      </Row>
      <Row label="Instrucciones" focused={focus === "instructions"}>
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
          placeholder="Cómo debería trabajar este agente"
          focused={focus === "instructions"}
        />
      </Row>
      {error && <text fg={DANGER}>{error}</text>}
      <box flexGrow={1} />
      <text fg={MUTED}>
        {focus === "model"
          ? "Escribe para filtrar · ↑/↓ elegir · Enter confirmar · Tab siguiente · Ctrl+S guardar · Esc cancelar"
          : "Tab siguiente · ←/→ cambiar · Ctrl+S guardar · Esc cancelar"}
      </text>
    </box>
  )
}
