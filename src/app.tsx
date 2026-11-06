import { useKeyboard, useRenderer } from "@opentui/react"

export function App() {
  const renderer = useRenderer()

  useKeyboard((key) => {
    if (key.name === "q") renderer.destroy()
  })

  return (
    <box flexDirection="column" padding={1}>
      <text>Ravex Agents</text>
      <text>Press q to quit</text>
    </box>
  )
}
