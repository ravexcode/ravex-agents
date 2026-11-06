import { useEffect, useRef, useState } from "react"
import { ACCENT, MUTED, TEXT } from "./theme.ts"

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const FRAME_MS = 80
const SHINE_WIDTH = 3
// Pauses between sweeps, so the label doesn't look like it's flickering.
const SHINE_REST = 12

/** Owns its timer, so that animating doesn't render the rest of the screen again. */
export function Spinner({ label }: { label: string }) {
  const [tick, setTick] = useState(0)
  const started = useRef(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), FRAME_MS)
    return () => clearInterval(timer)
  }, [])

  const text = `${label}…`
  const shine = tick % (text.length + SHINE_REST)
  const seconds = Math.floor((Date.now() - started.current) / 1000)

  return (
    <text wrapMode="none" flexShrink={0}>
      <span fg={ACCENT}>{`${FRAMES[tick % FRAMES.length]} `}</span>
      <span fg={MUTED}>{text.slice(0, shine)}</span>
      <span fg={TEXT}>{text.slice(shine, shine + SHINE_WIDTH)}</span>
      <span fg={MUTED}>{text.slice(shine + SHINE_WIDTH)}</span>
      <span fg={MUTED}>{` ${seconds}s`}</span>
    </text>
  )
}
