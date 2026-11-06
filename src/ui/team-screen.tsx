import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { Agent } from "../agents/types.ts"
import { ACCENT, fit, MUTED, TEXT } from "./theme.ts"

// The two markers, the name, the mode, the origin, their spaces and the frame.
const OTHER_COLUMNS_WIDTH = 49
const MIN_ENGINE_WIDTH = 16

const ORIGIN_LABELS: Record<Agent["origin"], string> = {
  builtin: "base",
  global: "global",
  project: "proyecto",
}

export interface TeamScreenProps {
  agents: Agent[]
  orchestratorId: string
  cursor: number
  height: number
  onMove: (cursor: number) => void
  onNew: () => void
  onEdit: (agent: Agent) => void
  onDelete: (agent: Agent) => void
  onChooseOrchestrator: (agent: Agent) => void
  onClose: () => void
}

export function TeamScreen(props: TeamScreenProps) {
  const { agents, orchestratorId, cursor, height, onMove, onNew, onEdit, onDelete, onChooseOrchestrator, onClose } = props
  const selected = agents[cursor]
  const { width } = useTerminalDimensions()
  const engineWidth = Math.max(MIN_ENGINE_WIDTH, width - OTHER_COLUMNS_WIDTH)

  useKeyboard((key) => {
    if (key.name === "escape") onClose()
    else if (key.name === "up") onMove((cursor - 1 + agents.length) % agents.length)
    else if (key.name === "down") onMove((cursor + 1) % agents.length)
    else if (key.name === "n") onNew()
    else if (!selected) return
    else if (key.name === "e" || key.name === "return" || key.name === "enter") onEdit(selected)
    else if (key.name === "d") onDelete(selected)
    else if (key.name === "o") onChooseOrchestrator(selected)
  })

  const visible = Math.max(1, height - 6)
  const start = Math.max(0, Math.min(cursor, agents.length - visible))

  return (
    <box flexGrow={1} flexDirection="column" border borderColor={ACCENT} title=" Equipo " paddingLeft={1} paddingRight={1}>
      <text fg={MUTED}>{`   ${fit("Agente", 18, true)} ${fit("Proveedor/modelo", engineWidth, true)} ${fit("Máximo", 10, true)} Origen`}</text>
      {agents.slice(start, start + visible).map((agent) => {
        const isSelected = agent.id === selected?.id
        const marker = agent.id === orchestratorId ? "★" : " "
        const engine = agent.model ? `${agent.provider}/${agent.model}` : agent.provider
        return (
          <text key={agent.id} fg={isSelected ? ACCENT : TEXT} wrapMode="none">
            {`${isSelected ? "▸" : " "}${marker} ${fit(agent.name, 18, true)} ${fit(engine, engineWidth, true)} ${fit(agent.mode === "edit" ? "edición" : "lectura", 10, true)} ${ORIGIN_LABELS[agent.origin]}`}
          </text>
        )
      })}
      <box flexGrow={1} />
      <text fg={MUTED}>★ orquestador · ↑/↓ mover · n nuevo · e editar · d borrar · o elegir orquestador · Esc volver</text>
    </box>
  )
}
