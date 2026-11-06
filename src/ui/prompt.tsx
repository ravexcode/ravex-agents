import type { InputRenderable } from "@opentui/core"
import type { RefObject } from "react"
import { ACCENT, MUTED } from "./theme.ts"

export interface PromptProps {
  inputRef: RefObject<InputRenderable | null>
  focused: boolean
  placeholder: string
  onSubmit: () => void
  onInput?: (value: string) => void
}

export function Prompt({ inputRef, focused, placeholder, onSubmit, onInput }: PromptProps) {
  return (
    <box flexDirection="row" height={1} marginTop={1} flexShrink={0}>
      <text fg={focused ? ACCENT : MUTED} flexShrink={0}>
        {"› "}
      </text>
      <input ref={inputRef} flexGrow={1} focused={focused} placeholder={placeholder} onSubmit={onSubmit} onInput={onInput} />
    </box>
  )
}
