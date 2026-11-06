import { CliRenderEvents, createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { AgentStore, defaultAgentPaths } from "./agents/store.ts"
import { App } from "./app.tsx"
import { ALL_AGENTS, Orchestrator } from "./orchestrator.ts"
import { providers } from "./providers/index.ts"

const store = new AgentStore(defaultAgentPaths(process.cwd()), providers)
const { agents, errors } = store.load()
const orchestrator = new Orchestrator(providers, agents)
const renderer = await createCliRenderer({ exitOnCtrlC: true })

// Running agents would otherwise outlive the app and keep the process open.
renderer.once(CliRenderEvents.DESTROY, () => orchestrator.cancel(ALL_AGENTS))

try {
  createRoot(renderer).render(
    <App
      orchestrator={orchestrator}
      store={store}
      providerIds={providers.map((provider) => provider.id)}
      initialErrors={errors}
    />,
  )
} catch (error) {
  renderer.destroy()
  throw error
}
