import { parseJsonObject, summarizeInput } from "./parse.ts"
import type { PermissionMode, Provider, ProviderEvent, ToolId } from "./types.ts"

/** Without Skill or Task, an agent also can't load other skills or start subagents. */
function toolArgs(tools: ToolId[] | undefined, mode: PermissionMode): string[] {
  if (!tools) return []
  const names = [
    "Read",
    "Glob",
    "Grep",
    ...(tools.includes("edit") && mode === "edit" ? ["Edit", "Write", "NotebookEdit"] : []),
    ...(tools.includes("shell") ? ["Bash"] : []),
    ...(tools.includes("web") ? ["WebFetch", "WebSearch"] : []),
  ]
  return [
    "--tools",
    names.join(","),
    // Otherwise any command that isn't a simple file operation is refused. In
    // read-only mode, leaving this out keeps only commands that change nothing.
    ...(tools.includes("shell") && mode === "edit" ? ["--allowedTools", "Bash"] : []),
    // With no config given, this leaves no MCP servers at all.
    ...(tools.includes("mcp") ? [] : ["--strict-mcp-config"]),
  ]
}

export const claude: Provider = {
  id: "claude",
  label: "Claude",
  binary: "claude",

  // The CLI has no command that lists models, but these aliases follow the latest of each.
  listModels: async () => ["fable", "opus", "sonnet", "haiku"],

  buildArgs({ prompt, mode, sessionId, model, instructions, tools, nativeSkills }) {
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      mode === "edit" ? "acceptEdits" : "dontAsk",
      ...(model ? ["--model", model] : []),
      ...(instructions ? ["--append-system-prompt", instructions] : []),
      ...toolArgs(tools, mode),
      ...(nativeSkills === false ? ["--disable-slash-commands"] : []),
      ...(sessionId ? ["--resume", sessionId] : []),
      "--",
      prompt,
    ]
  },

  parseLine(line) {
    const event = parseJsonObject(line)
    if (!event) return []

    // Events from subagents would interleave with the main conversation.
    if (event.parent_tool_use_id) return []

    switch (event.type) {
      case "system":
        return event.subtype === "init" && typeof event.session_id === "string"
          ? [{ type: "session", sessionId: event.session_id }]
          : []

      case "stream_event": {
        const inner = event.event
        if (inner?.type === "content_block_start" && inner.content_block?.type === "text") {
          return [{ type: "text-start" }]
        }
        if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
          return [{ type: "text-delta", text: String(inner.delta.text ?? "") }]
        }
        return []
      }

      case "assistant": {
        const content: unknown = event.message?.content
        if (!Array.isArray(content)) return []
        return content.flatMap((block): ProviderEvent[] =>
          block?.type === "tool_use"
            ? [{ type: "tool", name: String(block.name), detail: summarizeInput(block.input) }]
            : [],
        )
      }

      case "result":
        if (!event.is_error) return []
        return [
          {
            type: "error",
            fatal: true,
            message: String(event.result ?? event.errors?.[0] ?? event.subtype ?? "Claude failed"),
          },
        ]

      default:
        return []
    }
  },
}
