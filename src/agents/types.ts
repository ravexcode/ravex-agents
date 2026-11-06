import type { PermissionMode, ProviderId } from "../providers/types.ts"

export type AgentOrigin = "builtin" | "global" | "project"
export type SavableOrigin = Exclude<AgentOrigin, "builtin">

export interface AgentDefinition {
  id: string
  name: string
  /** Tells parent agents when to delegate to this one. */
  description: string
  provider: ProviderId
  /** The CLI's default model when omitted. */
  model?: string
  instructions: string
  /** The most this agent may do; the session and its parent can lower it. */
  mode: PermissionMode
  /** IDs of the agents this one may delegate to. */
  subagents: string[]
}

export interface Agent extends AgentDefinition {
  origin: AgentOrigin
}
