import { parseCodexModels, readCommand } from "./models.ts"
import { parseJsonObject, truncateDetail } from "./parse.ts"
import type { Provider, ProviderEvent } from "./types.ts"

function parseItem(phase: string, item: Record<string, any> | undefined): ProviderEvent[] {
  // Report commands when they start, and everything else once it has finished.
  if (phase === "item.started") {
    return item?.type === "command_execution"
      ? [{ type: "tool", name: "shell", detail: truncateDetail(String(item.command ?? "")) }]
      : []
  }

  switch (item?.type) {
    case "agent_message":
      return [{ type: "text-start" }, { type: "text-delta", text: String(item.text ?? "") }]
    case "file_change": {
      const paths = Array.isArray(item.changes)
        ? item.changes.map((change: { path?: unknown }) => String(change?.path ?? "")).join(", ")
        : ""
      return [{ type: "tool", name: "edit", detail: truncateDetail(paths) }]
    }
    case "mcp_tool_call":
      return [{ type: "tool", name: String(item.tool ?? "mcp") }]
    case "web_search":
      return [{ type: "tool", name: "web_search", detail: truncateDetail(String(item.query ?? "")) }]
    default:
      return []
  }
}

export const codex: Provider = {
  id: "codex",
  label: "Codex",
  binary: "codex",

  // Commands are how it reads files, so its sandbox limits them instead. Its MCP
  // servers can only be turned off one by one, which would need their names here.
  lockedTools: ["shell", "mcp"],

  listModels: async () => parseCodexModels(await readCommand(["codex", "debug", "models"])),

  buildArgs({ prompt, mode, sessionId, model, instructions, tools, nativeSkills }) {
    // `codex exec resume` has no --sandbox flag, so both paths set it as config.
    const sandbox = mode === "edit" ? "workspace-write" : "read-only"
    return [
      "exec",
      ...(sessionId ? ["resume"] : []),
      "--json",
      "-c",
      `sandbox_mode="${sandbox}"`,
      ...(model ? ["-m", model] : []),
      // Config values are parsed as TOML, whose strings accept JSON's escapes.
      ...(instructions ? ["-c", `developer_instructions=${JSON.stringify(instructions)}`] : []),
      ...(tools && !tools.includes("web") ? ["-c", 'web_search="disabled"'] : []),
      ...(nativeSkills === false ? ["-c", "skills.include_instructions=false"] : []),
      ...(sessionId ? [sessionId] : []),
      "--",
      prompt,
    ]
  },

  parseLine(line) {
    const event = parseJsonObject(line)
    if (!event) return []

    switch (event.type) {
      case "thread.started":
        return typeof event.thread_id === "string"
          ? [{ type: "session", sessionId: event.thread_id }]
          : []
      case "item.started":
      case "item.completed":
        return parseItem(event.type, event.item)
      // `error` can be transient, such as a reconnect notice; `turn.failed` is final.
      case "error":
        return [{ type: "error", fatal: false, message: String(event.message ?? "Codex error") }]
      case "turn.failed":
        return [{ type: "error", fatal: true, message: String(event.error?.message ?? "Codex failed") }]
      default:
        return []
    }
  },
}
