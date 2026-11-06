import type { PermissionMode } from "../providers/types.ts"
import { ListScreen } from "./list-screen.tsx"
import { WARNING } from "./theme.ts"

export interface SettingsScreenProps {
  mode: PermissionMode
  height: number
  onNewAgent: () => void
  onTeam: () => void
  onToggleMode: () => void
  onClose: () => void
}

export function SettingsScreen({ mode, height, onNewAgent, onTeam, onToggleMode, onClose }: SettingsScreenProps) {
  const actions: Record<string, () => void> = { new: onNewAgent, team: onTeam, mode: onToggleMode }
  return (
    <ListScreen
      title="Settings"
      labelWidth={14}
      height={height}
      hints="↑/↓ move · Enter select · Esc back"
      items={[
        { id: "new", label: "New agent", detail: "Add an agent to the team" },
        { id: "team", label: "Team", detail: "Edit or delete agents, or choose the orchestrator" },
        {
          id: "mode",
          label: "Session mode",
          detail: mode === "edit" ? "EDIT" : "READ-ONLY",
          ...(mode === "edit" ? { detailColor: WARNING } : {}),
        },
      ]}
      onSelect={(item) => actions[item.id]?.()}
      onClose={onClose}
    />
  )
}
