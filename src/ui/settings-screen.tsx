import { useState } from "react"
import type { PermissionMode } from "../providers/types.ts"
import { useKeys } from "./keys.ts"
import { ACCENT, fit, MUTED, TEXT, WARNING } from "./theme.ts"

const LABEL_WIDTH = 14

export interface SettingsScreenProps {
  mode: PermissionMode
  onNewAgent: () => void
  onTeam: () => void
  onToggleMode: () => void
  onClose: () => void
}

export function SettingsScreen({ mode, onNewAgent, onTeam, onToggleMode, onClose }: SettingsScreenProps) {
  const [cursor, setCursor] = useState(0)
  const items = [
    { label: "New agent", detail: "Add an agent to the team", run: onNewAgent },
    { label: "Team", detail: "Edit or delete agents, or choose the orchestrator", run: onTeam },
    {
      label: "Session mode",
      detail: mode === "edit" ? "EDIT" : "READ-ONLY",
      detailColor: mode === "edit" ? WARNING : undefined,
      run: onToggleMode,
    },
  ]

  useKeys((key) => {
    if (key.name === "escape") onClose()
    else if (key.name === "up") setCursor((cursor - 1 + items.length) % items.length)
    else if (key.name === "down") setCursor((cursor + 1) % items.length)
    else if (key.name === "return" || key.name === "enter") items[cursor]?.run()
  })

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={ACCENT} marginBottom={1} flexShrink={0}>
        Settings
      </text>
      {items.map((item, position) => {
        const selected = position === cursor
        return (
          <text key={item.label} wrapMode="none" flexShrink={0}>
            <span fg={selected ? ACCENT : TEXT}>{`${selected ? "▸" : " "} ${fit(item.label, LABEL_WIDTH, true)} `}</span>
            <span fg={item.detailColor ?? MUTED}>{item.detail}</span>
          </text>
        )
      })}
      <box flexGrow={1} />
      <text fg={MUTED} wrapMode="none" flexShrink={0}>
        ↑/↓ move · Enter select · Esc back
      </text>
    </box>
  )
}
