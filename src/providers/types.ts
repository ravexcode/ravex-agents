export type ProviderId = "claude" | "codex" | "opencode"

/**
 * "read-only" lets an agent inspect the project but not change it.
 * "edit" lets it change files, using each CLI's own approval rules.
 */
export type PermissionMode = "read-only" | "edit"

export interface TurnRequest {
  prompt: string
  cwd: string
  mode: PermissionMode
  sessionId?: string
  /** The CLI's default model when omitted. */
  model?: string
  instructions?: string
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
  buildArgs(request: TurnRequest): string[]
  buildEnv?(request: TurnRequest): Record<string, string>
  parseLine(line: string): ProviderEvent[]
}
