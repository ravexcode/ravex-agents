import type { PermissionMode, ProviderId } from "../providers/types.ts"

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
}

export interface Agent extends AgentDefinition {
  origin: AgentOrigin
}

export const DEFAULT_ORCHESTRATOR = "lead"
