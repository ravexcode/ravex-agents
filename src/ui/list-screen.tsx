import { useState } from "react"
import { useKeys, type Keypress } from "./keys.ts"
import { ACCENT, fit, MUTED, TEXT } from "./theme.ts"

// The title, the space under it and the hints.
const FIXED_LINES = 4

export interface ListItem {
  id: string
  label: string
  detail?: string
  detailColor?: string
}

export interface ListScreenProps {
  title: string
  items: ListItem[]
  labelWidth: number
  height: number
  hints: string
  initialCursor?: number
  onSelect: (item: ListItem) => void
  /** For keys other than moving, selecting and going back. */
  onKey?: (key: Keypress, item: ListItem) => void
  onClose: () => void
}

export function ListScreen(props: ListScreenProps) {
  const { title, items, labelWidth, height, hints, initialCursor = 0, onSelect, onKey, onClose } = props
  const [position, setPosition] = useState(initialCursor)
  const cursor = Math.max(0, Math.min(position, items.length - 1))
  const selected = items[cursor]

  useKeys((key) => {
    if (key.name === "escape") onClose()
    else if (!selected) return
    // Several presses can arrive before the next render, as when holding a key down.
    else if (key.name === "up") setPosition((current) => (current - 1 + items.length) % items.length)
    else if (key.name === "down") setPosition((current) => (current + 1) % items.length)
    else if (key.name === "return" || key.name === "enter") onSelect(selected)
    else onKey?.(key, selected)
  })

  const visible = Math.max(1, height - FIXED_LINES)
  const start = Math.max(0, Math.min(cursor - Math.floor(visible / 2), items.length - visible))

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={ACCENT} marginBottom={1} flexShrink={0}>
        {title}
      </text>
      {items.slice(start, start + visible).map((item) => {
        const isSelected = item.id === selected?.id
        return (
          <text key={item.id} wrapMode="none" flexShrink={0}>
            <span fg={isSelected ? ACCENT : TEXT}>{`${isSelected ? "▸" : " "} ${fit(item.label, labelWidth, true)} `}</span>
            <span fg={item.detailColor ?? MUTED}>{item.detail ?? ""}</span>
          </text>
        )
      })}
      <box flexGrow={1} />
      <text fg={MUTED} wrapMode="none" flexShrink={0}>
        {hints}
      </text>
    </box>
  )
}
