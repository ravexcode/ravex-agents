import type { Command } from "./commands.ts"
import { ACCENT, BACKGROUND, fit, MUTED, TEXT } from "./theme.ts"

const NAME_WIDTH = 28
export const MAX_MENU_LINES = 9

function usage(command: Command): string {
  return `/${command.name}${command.args ? ` ${command.args}` : ""}`
}

export function CommandMenu({ commands, cursor }: { commands: Command[]; cursor: number }) {
  const start = Math.max(0, Math.min(cursor - MAX_MENU_LINES + 1, commands.length - MAX_MENU_LINES))
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={BACKGROUND}>
      {commands.slice(start, start + MAX_MENU_LINES).map((command) => {
        const selected = command === commands[cursor]
        return (
          <text key={command.name} wrapMode="none" flexShrink={0}>
            <span fg={selected ? ACCENT : TEXT}>{`${selected ? "▸" : " "} ${fit(usage(command), NAME_WIDTH, true)} `}</span>
            <span fg={MUTED}>{command.description}</span>
          </text>
        )
      })}
    </box>
  )
}
