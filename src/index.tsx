import { CliRenderEvents, createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { defaultSkillDirs, SkillLibrary } from "./agents/skills.ts"
import { AgentStore, defaultAgentPaths } from "./agents/store.ts"
import { App } from "./app.tsx"
import { defaultStatePath, StateFile } from "./core/persistence.ts"
import { Team } from "./core/team.ts"
import { providers } from "./providers/index.ts"
import { createModelCatalog } from "./providers/models.ts"
import { BACKGROUND } from "./ui/theme.ts"

const cwd = process.cwd()
const store = new AgentStore(defaultAgentPaths(cwd), providers)
const { agents, orchestratorId, errors } = store.load()
const skills = new SkillLibrary(defaultSkillDirs(cwd))
const stateFile = new StateFile(defaultStatePath(cwd))
const { snapshot, error: stateError } = stateFile.load()
const team = new Team(providers, agents, orchestratorId, {
  cwd,
  persistence: stateFile,
  snapshot,
  resolveSkills: skills.resolve,
})
const listSkills = () => skills.list()
const renderer = await createCliRenderer({ exitOnCtrlC: true, backgroundColor: BACKGROUND })

// Running agents would otherwise outlive the app and keep the process open.
renderer.once(CliRenderEvents.DESTROY, () => team.stop())

try {
  createRoot(renderer).render(
    <App
      team={team}
      store={store}
      providers={providers}
      listModels={createModelCatalog(providers)}
      listSkills={listSkills}
      initialErrors={errors}
      initialNotice={stateError}
    />,
  )
} catch (error) {
  renderer.destroy()
  throw error
}
