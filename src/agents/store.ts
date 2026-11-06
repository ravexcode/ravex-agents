import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Provider, ProviderId } from "../providers/types.ts"
import { removeCycles } from "./graph.ts"
import type { Agent, AgentDefinition, SavableOrigin } from "./types.ts"

export interface AgentPaths {
  global: string
  project: string
}

export type LoadErrors = Partial<Record<SavableOrigin, string>>

export interface LoadResult {
  agents: Agent[]
  errors: LoadErrors
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
    (agent.mode === "read-only" || agent.mode === "edit") &&
    Array.isArray(agent.subagents) &&
    agent.subagents.every((id) => typeof id === "string")
  )
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

  load(): LoadResult {
    const merged = new Map<string, Agent>()
    for (const provider of this.#providers) {
      merged.set(provider.id, {
        id: provider.id,
        name: provider.label,
        description: "",
        provider: provider.id,
        instructions: "",
        // The session's own mode is what limits these.
        mode: "edit",
        subagents: [],
        origin: "builtin",
      })
    }

    const errors: LoadErrors = {}
    // Project agents come last so that they win when IDs match.
    for (const origin of ["global", "project"] as const) {
      try {
        for (const agent of this.#read(origin)) merged.set(agent.id, { ...agent, origin })
      } catch (error) {
        errors[origin] = `${this.#paths[origin]}: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    return { agents: removeCycles([...merged.values()]), errors }
  }

  /** Throws, leaving the files untouched, if a file it needs to change is invalid. */
  save(definition: AgentDefinition, origin: SavableOrigin, previousOrigin?: SavableOrigin): void {
    const agents = this.#read(origin)
    const position = agents.findIndex((agent) => agent.id === definition.id)
    if (position === -1) agents.push(definition)
    else agents[position] = definition

    if (previousOrigin && previousOrigin !== origin) {
      const previous = this.#read(previousOrigin).filter((agent) => agent.id !== definition.id)
      this.#write(origin, agents)
      this.#write(previousOrigin, previous)
      return
    }
    this.#write(origin, agents)
  }

  /** Throws, leaving the file untouched, if the file is invalid. */
  delete(id: string, origin: SavableOrigin): void {
    this.#write(
      origin,
      this.#read(origin).filter((agent) => agent.id !== id),
    )
  }

  #read(origin: SavableOrigin): AgentDefinition[] {
    const path = this.#paths[origin]
    if (!existsSync(path)) return []

    const data: unknown = JSON.parse(readFileSync(path, "utf8"))
    const agents = (data as { agents?: unknown } | null)?.agents
    if (!Array.isArray(agents)) throw new Error('expected an object with an "agents" list')

    const invalid = agents.find((agent) => !isDefinition(agent, this.#providerIds))
    if (invalid !== undefined) throw new Error(`invalid agent: ${JSON.stringify(invalid).slice(0, 80)}`)
    return agents as AgentDefinition[]
  }

  #write(origin: SavableOrigin, agents: AgentDefinition[]): void {
    const path = this.#paths[origin]
    mkdirSync(dirname(path), { recursive: true })

    // A rename can't leave a half-written file behind if the app is interrupted.
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ agents }, null, 2)}\n`)
    renameSync(temporary, path)
  }
}
