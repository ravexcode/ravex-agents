import { buildTree } from "../agents/graph.ts"
import type { Agent } from "../agents/types.ts"
import { ALL_AGENTS, type Pane, type Target } from "../orchestrator.ts"
import { ACCENT, DANGER, MUTED, STATUS_COLORS, STATUS_ICONS, TEXT } from "./theme.ts"

export const SIDEBAR_WIDTH = 28
// Border, selection marker and status icon.
const NAME_SPACE = SIDEBAR_WIDTH - 6

function rowLabel(name: string, depth: number, isLastSibling: boolean, isProject: boolean): string {
  const branch = depth === 0 ? "" : `${"  ".repeat(depth - 1)}${isLastSibling ? "└ " : "├ "}`
  const tag = isProject ? " ·p" : ""
  const space = Math.max(1, NAME_SPACE - branch.length - tag.length)
  const shown = name.length > space ? `${name.slice(0, space - 1)}…` : name
  return `${branch}${shown}${tag}`
}

export function Sidebar({
  agents,
  panes,
  target,
}: {
  agents: Agent[]
  panes: Pane[]
  target: Target
}) {
  const allSelected = target === ALL_AGENTS

  return (
    <box width={SIDEBAR_WIDTH} flexShrink={0} border borderColor={MUTED} title=" Agents ">
      <scrollbox flexGrow={1}>
        <text fg={allSelected ? ACCENT : TEXT}>{`${allSelected ? "▸" : " "} All`}</text>
        {buildTree(agents).map((row) => {
          const agent = agents.find((candidate) => candidate.id === row.agentId)
          const pane = panes.find((candidate) => candidate.id === row.agentId)
          if (!agent || !pane) return null

          const selected = target === row.agentId
          return (
            <box key={row.key} flexDirection="row" height={1}>
              <text fg={selected ? ACCENT : TEXT} flexGrow={1}>
                {`${selected ? "▸" : " "} ${rowLabel(agent.name, row.depth, row.isLastSibling, agent.origin === "project")}`}
              </text>
              <text fg={pane.available ? STATUS_COLORS[pane.status] : DANGER}>
                {pane.available ? STATUS_ICONS[pane.status] : "!"}
              </text>
            </box>
          )
        })}
      </scrollbox>
    </box>
  )
}
