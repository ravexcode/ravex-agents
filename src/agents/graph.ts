import type { AgentDefinition } from "./types.ts"

/** The most delegation steps in a chain: lead → child → grandchild → great-grandchild. */
export const MAX_DELEGATION_DEPTH = 3

const RESERVED_IDS = new Set(["all"])

type Graph = Pick<AgentDefinition, "id" | "subagents">

export interface TreeRow {
  /** Unique per row, since an agent assigned to two parents appears twice. */
  key: string
  agentId: string
  depth: number
  isLastSibling: boolean
}

export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function childrenOf(agent: Graph, byId: Map<string, Graph>): string[] {
  return agent.subagents.filter((id) => byId.has(id))
}

function index<T extends Graph>(agents: T[]): Map<string, T> {
  return new Map(agents.map((agent) => [agent.id, agent]))
}

/** Returns the steps of the longest chain from `id`, or null if it reaches a cycle. */
function longestChain(id: string, byId: Map<string, Graph>, path: Set<string>): number | null {
  if (path.has(id)) return null
  const agent = byId.get(id)
  if (!agent) return 0

  path.add(id)
  let longest = 0
  for (const child of childrenOf(agent, byId)) {
    const length = longestChain(child, byId, path)
    if (length === null) {
      path.delete(id)
      return null
    }
    longest = Math.max(longest, length + 1)
  }
  path.delete(id)
  return longest
}

export function validateAgent(
  candidate: Pick<AgentDefinition, "id" | "name" | "subagents">,
  agents: Graph[],
  editingId?: string,
): string | undefined {
  if (!candidate.name.trim()) return "Name is required."
  if (!candidate.id) return "Name needs at least one letter or number."
  if (RESERVED_IDS.has(candidate.id)) return `"${candidate.id}" is a reserved name.`
  if (candidate.id !== editingId && agents.some((agent) => agent.id === candidate.id)) {
    return `An agent with the ID "${candidate.id}" already exists.`
  }

  const merged = [...agents.filter((agent) => agent.id !== candidate.id), candidate]
  const byId = index(merged)
  for (const agent of merged) {
    const length = longestChain(agent.id, byId, new Set())
    if (length === null) return "These subagents would create a delegation cycle."
    if (length > MAX_DELEGATION_DEPTH) {
      return `Delegation chains can have at most ${MAX_DELEGATION_DEPTH} steps.`
    }
  }
  return undefined
}

/**
 * Drops assignments that form a cycle, which can only come from hand-edited
 * files. A cycle could otherwise deadlock agents waiting on each other.
 */
export function removeCycles<T extends Graph>(agents: T[]): T[] {
  const result = new Map(agents.map((agent) => [agent.id, { ...agent, subagents: [] as string[] }]))
  for (const agent of agents) {
    const current = result.get(agent.id)
    if (!current) continue
    for (const child of agent.subagents) {
      current.subagents.push(child)
      if (longestChain(agent.id, result as Map<string, Graph>, new Set()) === null) {
        current.subagents.pop()
      }
    }
  }
  return agents.map((agent) => result.get(agent.id) ?? agent)
}

export function rootIds(agents: Graph[]): string[] {
  const byId = index(agents)
  const assigned = new Set(agents.flatMap((agent) => childrenOf(agent, byId)))
  return agents.filter((agent) => !assigned.has(agent.id)).map((agent) => agent.id)
}

export function buildTree(agents: Graph[]): TreeRow[] {
  const byId = index(agents)
  const rows: TreeRow[] = []

  const visit = (id: string, depth: number, parentKey: string, isLastSibling: boolean) => {
    const key = `${parentKey}/${id}`
    rows.push({ key, agentId: id, depth, isLastSibling })
    const agent = byId.get(id)
    if (!agent) return
    const children = childrenOf(agent, byId)
    children.forEach((child, position) => {
      visit(child, depth + 1, key, position === children.length - 1)
    })
  }

  const roots = rootIds(agents)
  roots.forEach((id, position) => visit(id, 0, "", position === roots.length - 1))
  return rows
}
