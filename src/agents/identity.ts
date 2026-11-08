import type { AgentDefinition } from "./types.ts"

const RESERVED_IDS = new Set(["all", "room", "team", "you", "system"])

export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function validateAgent(
  candidate: Pick<AgentDefinition, "id" | "name">,
  agents: Pick<AgentDefinition, "id">[],
  editingId?: string,
): string | undefined {
  if (!candidate.name.trim()) return "Name is required."
  if (!candidate.id) return "Name needs at least one letter or number."
  if (RESERVED_IDS.has(candidate.id)) return `"${candidate.id}" is a reserved name.`
  if (candidate.id !== editingId && agents.some((agent) => agent.id === candidate.id)) {
    return `An agent with the ID "${candidate.id}" already exists.`
  }
  return undefined
}
