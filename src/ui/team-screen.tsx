import { useTerminalDimensions } from "@opentui/react"
import type { Agent } from "../agents/types.ts"
import { useKeys } from "./keys.ts"
import { ACCENT, fit, MUTED, TEXT } from "./theme.ts"

const NAME_WIDTH = 16
const SKILLS_WIDTH = 8
const MIN_ENGINE_WIDTH = 14
const MIN_TOOLS_WIDTH = 14
// The markers, the name, the skills, their spaces and the side padding.
const FIXED_WIDTH = 3 + NAME_WIDTH + SKILLS_WIDTH + 5
// The heading, the column titles, the hints and the space between them.
const FIXED_LINES = 6

function toolsLabel(agent: Agent): string {
  if (agent.tools) return agent.tools.length ? agent.tools.join(" ") : "read only"
  return agent.mode === "edit" ? "all" : "read only"
}

function skillsLabel(agent: Agent): string {
  if (!agent.skills) return "default"
  return agent.skills.length ? String(agent.skills.length) : "none"
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
  const shared = Math.max(MIN_ENGINE_WIDTH + MIN_TOOLS_WIDTH, width - FIXED_WIDTH)
  const toolsWidth = Math.max(MIN_TOOLS_WIDTH, Math.floor(shared * 0.4))
  const engineWidth = shared - toolsWidth

  useKeys((key) => {
    if (key.name === "escape") onClose()
    else if (key.name === "up") onMove((cursor - 1 + agents.length) % agents.length)
    else if (key.name === "down") onMove((cursor + 1) % agents.length)
    else if (key.name === "n") onNew()
    else if (!selected) return
    else if (key.name === "e" || key.name === "return" || key.name === "enter") onEdit(selected)
    else if (key.name === "d") onDelete(selected)
    else if (key.name === "o") onChooseOrchestrator(selected)
  })

  const visible = Math.max(1, height - FIXED_LINES)
  const start = Math.max(0, Math.min(cursor, agents.length - visible))

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={ACCENT} flexShrink={0}>
        Team
      </text>
      <text fg={MUTED} marginTop={1} wrapMode="none" flexShrink={0}>
        {`   ${fit("Agent", NAME_WIDTH, true)} ${fit("Provider/model", engineWidth, true)} ${fit("Tools", toolsWidth, true)} Skills`}
      </text>
      {agents.slice(start, start + visible).map((agent) => {
        const isSelected = agent.id === selected?.id
        const marker = agent.id === orchestratorId ? "★" : " "
        const engine = agent.model ? `${agent.provider}/${agent.model}` : agent.provider
        return (
          <text key={agent.id} fg={isSelected ? ACCENT : TEXT} wrapMode="none">
            {`${isSelected ? "▸" : " "}${marker} ${fit(agent.name, NAME_WIDTH, true)} ${fit(engine, engineWidth, true)} ${fit(toolsLabel(agent), toolsWidth, true)} ${skillsLabel(agent)}`}
          </text>
        )
      })}
      <box flexGrow={1} />
      <text fg={MUTED} wrapMode="none" flexShrink={0}>
        ★ orchestrator · ↑/↓ move · n new · e edit · d delete · o make orchestrator · Esc back
      </text>
    </box>
  )
}
