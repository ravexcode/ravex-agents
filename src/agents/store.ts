import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Provider, ProviderId } from "../providers/types.ts"
import { DEFAULT_ORCHESTRATOR, type Agent, type AgentDefinition, type SavableOrigin } from "./types.ts"

export interface AgentPaths {
  global: string
  project: string
}

export type LoadErrors = Partial<Record<SavableOrigin, string>>

export interface LoadResult {
  agents: Agent[]
  orchestratorId: string
  errors: LoadErrors
}

interface AgentFile {
  agents: AgentDefinition[]
  orchestrator?: string
}

export function defaultAgentPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): AgentPaths {
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return {
    global: join(configHome, "ravex-agents", "agents.json"),
    project: join(cwd, ".ravex", "agents.json"),
  }
}

function isDefinition(value: unknown, providerIds: Set<ProviderId>): value is AgentDefinition {
  if (typeof value !== "object" || value === null) return false
  const agent = value as Record<string, unknown>
  return (
    typeof agent.id === "string" &&
    agent.id !== "" &&
    typeof agent.name === "string" &&
    typeof agent.description === "string" &&
    providerIds.has(agent.provider as ProviderId) &&
    (agent.model === undefined || typeof agent.model === "string") &&
    typeof agent.instructions === "string" &&
    (agent.mode === "read-only" || agent.mode === "edit")
  )
}

/** Keeps only known fields, which also drops `subagents` from older files. */
function normalize(agent: AgentDefinition): AgentDefinition {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    provider: agent.provider,
    ...(agent.model ? { model: agent.model } : {}),
    instructions: agent.instructions,
    mode: agent.mode,
  }
}

export class AgentStore {
  readonly #paths: AgentPaths
  readonly #providers: Provider[]
  readonly #providerIds: Set<ProviderId>

  constructor(paths: AgentPaths, providers: Provider[]) {
    this.#paths = paths
    this.#providers = providers
    this.#providerIds = new Set(providers.map((provider) => provider.id))
  }

  /** Deleting a saved agent with one of these IDs restores the original. */
  isBuiltin(id: string): boolean {
    return id === DEFAULT_ORCHESTRATOR || this.#providerIds.has(id as ProviderId)
  }

  load(): LoadResult {
    const merged = new Map<string, Agent>()
    const first = this.#providers[0]
    if (first) {
      merged.set(DEFAULT_ORCHESTRATOR, {
        id: DEFAULT_ORCHESTRATOR,
        name: "Lead",
        description: "Planifica el trabajo y reparte tareas al equipo.",
        provider: first.id,
        instructions: "",
        mode: "read-only",
        origin: "builtin",
      })
    }
    for (const provider of this.#providers) {
      merged.set(provider.id, {
        id: provider.id,
        name: provider.label,
        description: "",
        provider: provider.id,
        instructions: "",
        // The session's own mode is what limits these.
        mode: "edit",
        origin: "builtin",
      })
    }

    const errors: LoadErrors = {}
    let orchestrator: string | undefined
    // Project agents come last so that they win when IDs match.
    for (const origin of ["global", "project"] as const) {
      try {
        const file = this.#read(origin)
        for (const agent of file.agents) merged.set(agent.id, { ...agent, origin })
        orchestrator = file.orchestrator ?? orchestrator
      } catch (error) {
        errors[origin] = `${this.#paths[origin]}: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    return {
      agents: [...merged.values()],
      orchestratorId: orchestrator && merged.has(orchestrator) ? orchestrator : DEFAULT_ORCHESTRATOR,
      errors,
    }
  }

  /** Throws, leaving the files untouched, if a file it needs to change is invalid. */
  save(definition: AgentDefinition, origin: SavableOrigin, previousOrigin?: SavableOrigin): void {
    const target = this.#read(origin)
    const normalized = normalize(definition)
    const position = target.agents.findIndex((agent) => agent.id === definition.id)
    if (position === -1) target.agents.push(normalized)
    else target.agents[position] = normalized

    if (previousOrigin && previousOrigin !== origin) {
      const previous = this.#read(previousOrigin)
      previous.agents = previous.agents.filter((agent) => agent.id !== definition.id)
      this.#write(origin, target)
      this.#write(previousOrigin, previous)
      return
    }
    this.#write(origin, target)
  }

  /** Throws, leaving the file untouched, if the file is invalid. */
  delete(id: string, origin: SavableOrigin): void {
    const file = this.#read(origin)
    file.agents = file.agents.filter((agent) => agent.id !== id)
    this.#write(origin, file)
  }

  /** Throws, leaving the files untouched, if a file it needs to change is invalid. */
  setOrchestrator(id: string, origin: SavableOrigin = "global"): void {
    const target = { ...this.#read(origin), orchestrator: id }
    // A project's choice wins over the global one, so it can't be left behind.
    const project = origin === "global" ? this.#read("project") : undefined
    this.#write(origin, target)
    if (project?.orchestrator) {
      delete project.orchestrator
      this.#write("project", project)
    }
  }

  #read(origin: SavableOrigin): AgentFile {
    const path = this.#paths[origin]
    if (!existsSync(path)) return { agents: [] }

    const data = JSON.parse(readFileSync(path, "utf8")) as { agents?: unknown; orchestrator?: unknown } | null
    const agents = data?.agents
    if (!Array.isArray(agents)) throw new Error('expected an object with an "agents" list')

    const invalid = agents.find((agent) => !isDefinition(agent, this.#providerIds))
    if (invalid !== undefined) throw new Error(`invalid agent: ${JSON.stringify(invalid).slice(0, 80)}`)
    return {
      agents: (agents as AgentDefinition[]).map(normalize),
      ...(typeof data?.orchestrator === "string" ? { orchestrator: data.orchestrator } : {}),
    }
  }

  #write(origin: SavableOrigin, file: AgentFile): void {
    const path = this.#paths[origin]
    mkdirSync(dirname(path), { recursive: true })

    // A rename can't leave a half-written file behind if the app is interrupted.
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`)
    renameSync(temporary, path)
  }
}
