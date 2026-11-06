import { CliRenderEvents, createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./app.tsx"
import { Orchestrator } from "./orchestrator.ts"
import { providers } from "./providers/index.ts"

const orchestrator = new Orchestrator(providers)
const renderer = await createCliRenderer({ exitOnCtrlC: true })

// Running agents would otherwise outlive the app and keep the process open.
renderer.once(CliRenderEvents.DESTROY, () => orchestrator.cancel("all"))

try {
  createRoot(renderer).render(<App orchestrator={orchestrator} />)
} catch (error) {
  renderer.destroy()
  throw error
}
