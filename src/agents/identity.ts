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
  if (!candidate.name.trim()) return "El nombre es obligatorio."
  if (!candidate.id) return "El nombre necesita al menos una letra o un número."
  if (RESERVED_IDS.has(candidate.id)) return `"${candidate.id}" es un nombre reservado.`
  if (candidate.id !== editingId && agents.some((agent) => agent.id === candidate.id)) {
    return `Ya existe un agente con el ID "${candidate.id}".`
  }
  return undefined
}
