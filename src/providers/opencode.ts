import { parseJsonObject, summarizeInput } from "./parse.ts"
import type { Provider } from "./types.ts"

const READ_ONLY_AGENT = "ravex-read-only"

// The built-in plan agent denies edits but still allows the shell, so it only
// stays read-only if the model chooses to. This allowlist withholds the tools.
const CONFIG = {
  agent: {
    [READ_ONLY_AGENT]: {
      mode: "primary",
      description: "Read-only agent used by Ravex Agents",
      permission: {
        "*": "deny",
        read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
        glob: "allow",
        grep: "allow",
        list: "allow",
      },
    },
  },
}

export const opencode: Provider = {
  id: "opencode",
  label: "OpenCode",
  binary: "opencode",
  env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(CONFIG) },

  buildArgs({ prompt, mode, sessionId }) {
    return [
      "run",
      // By default the work runs in a shared background service, which keeps
      // going after this process is killed. A private server stops with it, and
      // is also the one that reads the config from this process's environment.
      "--standalone",
      "--format",
      "json",
      // Always explicit because a resumed session otherwise keeps its last agent.
      "--agent",
      mode === "read-only" ? READ_ONLY_AGENT : "build",
      ...(sessionId ? ["--session", sessionId] : []),
      "--",
      prompt,
    ]
  },

  parseLine(line) {
    const event = parseJsonObject(line)
    if (!event) return []

    switch (event.type) {
      case "step_start":
        return typeof event.sessionID === "string"
          ? [{ type: "session", sessionId: event.sessionID }]
          : []
      case "text":
        return [{ type: "text-start" }, { type: "text-delta", text: String(event.part?.text ?? "") }]
      case "tool_use":
        return [
          {
            type: "tool",
            name: String(event.part?.tool ?? "tool"),
            detail: summarizeInput(event.part?.state?.input),
          },
        ]
      case "error":
        return [{ type: "error", fatal: true, message: String(event.error?.message ?? "OpenCode failed") }]
      default:
        return []
    }
  },
}
