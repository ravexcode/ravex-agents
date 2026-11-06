import type { PermissionMode, ProviderId, ToolId } from "../providers/types.ts"

export type AgentOrigin = "builtin" | "global" | "project"
export type SavableOrigin = Exclude<AgentOrigin, "builtin">

export interface AgentDefinition {
  id: string
  name: string
  /** Tells the orchestrator what to assign to this agent. */
  description: string
  provider: ProviderId
  /** The CLI's default model when omitted. */
  model?: string
  instructions: string
  /** The most this agent may do; the session and the task can lower it. */
  mode: PermissionMode
  /** How hard it thinks, in its CLI's own levels. The CLI's default when omitted. */
  effort?: string
  /** Everything the CLI offers when omitted. Reading the project is always allowed. */
  tools?: ToolId[]
  /** Names of the skills it always has. When omitted, it has whatever its CLI finds. */
  skills?: string[]
}

export interface Agent extends AgentDefinition {
  origin: AgentOrigin
}

export const DEFAULT_ORCHESTRATOR = "lead"

/** Commands can change files just as edits can. */
export function modeForTools(tools: ToolId[]): PermissionMode {
  return tools.includes("edit") || tools.includes("shell") ? "edit" : "read-only"
}
