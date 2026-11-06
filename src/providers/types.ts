export type ProviderId = "claude" | "codex" | "opencode"

/**
 * "read-only" lets an agent inspect the project but not change it.
 * "edit" lets it change files, using each CLI's own approval rules.
 */
export type PermissionMode = "read-only" | "edit"

/** What an agent may use beyond reading the project, which every agent can do. */
export const TOOL_IDS = ["edit", "shell", "web", "mcp"] as const
export type ToolId = (typeof TOOL_IDS)[number]

export interface TurnRequest {
  prompt: string
  cwd: string
  mode: PermissionMode
  sessionId?: string
  /** The CLI's default model when omitted. */
  model?: string
  instructions?: string
  /** The CLI's full default set when omitted. The permission mode still applies on top. */
  tools?: ToolId[]
  /** False hides the skills the CLI finds by itself. */
  nativeSkills?: boolean
}

export type ProviderEvent =
  | { type: "session"; sessionId: string }
  | { type: "text-start" }
  | { type: "text-delta"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "error"; message: string; fatal: boolean }

/** Adapts one agent CLI: how to invoke it and how to read its JSONL output. */
export interface Provider {
  id: ProviderId
  label: string
  binary: string
  /** Tools this CLI can't turn off, which it limits through its sandbox instead. */
  lockedTools?: ToolId[]
  buildArgs(request: TurnRequest): string[]
  buildEnv?(request: TurnRequest): Record<string, string>
  /** The models this CLI offers. Rejects if they can't be read. */
  listModels?(): Promise<string[]>
  parseLine(line: string): ProviderEvent[]
}
