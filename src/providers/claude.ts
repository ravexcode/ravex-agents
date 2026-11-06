import { parseJsonObject, summarizeInput } from "./parse.ts"
import type { Provider, ProviderEvent } from "./types.ts"

export const claude: Provider = {
  id: "claude",
  label: "Claude",
  binary: "claude",

  buildArgs({ prompt, mode, sessionId, model, instructions }) {
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
