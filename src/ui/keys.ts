import { useKeyboard } from "@opentui/react"

export interface Keypress {
  name: string
  ctrl: boolean
  shift: boolean
}

/**
 * Terminals disagree on Shift+letter: some name the key "p" and set the shift
 * flag, others name it "P". Handlers compare against lowercase names only.
 */
export function useKeys(handler: (key: Keypress) => void) {
  useKeyboard(({ name, ctrl, shift }) => {
    handler({ name: name.length === 1 ? name.toLowerCase() : name, ctrl, shift })
  })
}

/**
 * Without the Kitty protocol, Ctrl+Shift+P and Ctrl+P send the same byte, so this
 * covers both. Many terminals and editors keep those shortcuts for themselves and
 * never pass them on, which is why F2 opens the settings too.
 */
export function isSettingsKey(key: Keypress): boolean {
  return (key.ctrl && key.name === "p") || key.name === "f2"
}
