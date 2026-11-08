import type { Offer } from "./commands.ts"
import { ACCENT, BACKGROUND, fit, MUTED, TEXT } from "./theme.ts"

const NAME_WIDTH = 38
export const MAX_MENU_LINES = 11

function usage(offer: Offer): string {
  return `/${offer.name}${offer.args ? ` ${offer.args}` : ""}`
}

export function CommandMenu({ commands, cursor }: { commands: Offer[]; cursor: number }) {
  const start = Math.max(0, Math.min(cursor - MAX_MENU_LINES + 1, commands.length - MAX_MENU_LINES))
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={BACKGROUND}>
      {commands.slice(start, start + MAX_MENU_LINES).map((command) => {
        const selected = command === commands[cursor]
        return (
          <text key={command.name} wrapMode="none" flexShrink={0}>
            <span fg={selected ? ACCENT : TEXT}>{`${selected ? "▸" : " "} ${fit(usage(command), NAME_WIDTH, true)} `}</span>
            <span fg={MUTED}>{fit(command.description, command.description.length)}</span>
          </text>
        )
      })}
    </box>
  )
}
