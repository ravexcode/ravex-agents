import { CliRenderEvents, createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { version } from "../package.json"
import { defaultSkillDirs, SkillLibrary } from "./agents/skills.ts"
import { AgentStore, defaultAgentPaths } from "./agents/store.ts"
import { App } from "./app.tsx"
import { parseCli, USAGE } from "./cli.ts"
import { ConversationArchive } from "./core/archive.ts"
import { defaultArchiveDir, defaultStatePath, StateFile } from "./core/persistence.ts"
import { Team } from "./core/team.ts"
import { providers } from "./providers/index.ts"
import { createEffortCatalog, createModelCatalog } from "./providers/models.ts"
import { BACKGROUND } from "./ui/theme.ts"

const cli = parseCli(process.argv.slice(2), process.cwd())
if (cli.kind === "help") {
  console.log(USAGE)
  process.exit(0)
}
if (cli.kind === "version") {
  console.log(version)
  process.exit(0)
}
if (cli.kind === "error") {
  console.error(`ravexcode: ${cli.message}\n\n${USAGE}`)
  process.exit(1)
}

const cwd = cli.folder
// Commands that list models run from here, and should see the same project as the agents.
process.chdir(cwd)
const store = new AgentStore(defaultAgentPaths(cwd), providers)
const { agents, orchestratorId, errors } = store.load()
const skills = new SkillLibrary(defaultSkillDirs(cwd))
const statePath = defaultStatePath(cwd)
const stateFile = new StateFile(statePath)
const { snapshot, error: stateError } = stateFile.load()
const team = new Team(providers, agents, orchestratorId, {
  cwd,
  persistence: stateFile,
  archive: new ConversationArchive(defaultArchiveDir(statePath)),
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
      listEfforts={createEffortCatalog(providers)}
      listSkills={listSkills}
      initialErrors={errors}
      initialNotice={stateError}
    />,
  )
} catch (error) {
  renderer.destroy()
  throw error
}
