import { parseOpenCodeModels, readCommand } from "./models.ts"
import { parseJsonObject, summarizeInput } from "./parse.ts"
import type { Provider, TurnRequest } from "./types.ts"

const READ_ONLY_AGENT = "ravex-read-only"
const EDIT_AGENT = "build"
const CUSTOM_AGENT = "ravex-custom"

const READ_ONLY_PERMISSIONS = {
  "*": "deny",
  read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
  glob: "allow",
  grep: "allow",
  list: "allow",
}

function agentFor({ mode, tools }: Pick<TurnRequest, "mode" | "tools">): string {
  if (tools) return CUSTOM_AGENT
  return mode === "read-only" ? READ_ONLY_AGENT : EDIT_AGENT
}

/** Everything not listed stays denied, including subagents. */
function customPermissions({ mode, tools = [], nativeSkills }: TurnRequest): Record<string, unknown> {
  const canChange = mode === "edit"
  return {
    ...READ_ONLY_PERMISSIONS,
    ...(tools.includes("mcp")
      ? {
          // MCP tools are named <server>_<tool>, which also matches some of OpenCode's own.
          "*_*": "allow",
          "opencode_*": "deny",
          "experimental_*": "deny",
          external_directory: "deny",
        }
      : {}),
    ...(canChange && tools.includes("edit") ? { edit: "allow" } : {}),
    // Its shell has no read-only form, so it needs edit mode.
    ...(canChange && tools.includes("shell") ? { bash: "allow" } : {}),
    ...(tools.includes("web") ? { webfetch: "allow", websearch: "allow" } : {}),
    ...(nativeSkills === false ? {} : { skill: "allow" }),
  }
}

export const opencode: Provider = {
  id: "opencode",
  label: "OpenCode",
  binary: "opencode",

  listModels: async () => parseOpenCodeModels(await readCommand(["opencode", "models"])),

  buildEnv(request) {
    const { mode, instructions, tools, nativeSkills } = request
    const prompt = instructions ? { prompt: instructions } : {}
    const noSkills = nativeSkills === false ? { permission: { skill: "deny" } } : {}
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        agent: {
          // The built-in plan agent denies edits but still allows the shell, so it
          // only stays read-only if the model chooses to. This allowlist withholds the tools.
          [READ_ONLY_AGENT]: {
            mode: "primary",
            description: "Read-only agent used by Ravex Agents",
            permission: READ_ONLY_PERMISSIONS,
            ...(mode === "read-only" ? prompt : {}),
          },
          ...(mode === "edit" ? { [EDIT_AGENT]: { ...prompt, ...noSkills } } : {}),
          ...(tools
            ? {
                [CUSTOM_AGENT]: {
                  mode: "primary",
                  description: "Agent with the tools chosen in Ravex Agents",
                  permission: customPermissions(request),
                  ...prompt,
                },
              }
            : {}),
        },
      }),
    }
  },

  buildArgs({ prompt, mode, sessionId, model, tools }) {
    return [
      "run",
      // By default the work runs in a shared background service, which keeps
      // going after this process is killed. A private server stops with it, and
      // is also the one that reads the config from this process's environment.
      "--standalone",
      "--format",
      "json",
      "--thinking",
      // Always explicit because a resumed session otherwise keeps its last agent.
      "--agent",
      agentFor({ mode, tools }),
      ...(model ? ["-m", model] : []),
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
      case "reasoning":
        return [{ type: "thinking-start" }, { type: "thinking-delta", text: String(event.part?.text ?? "") }]
      // It only reports a tool once the tool has finished.
      case "tool_use":
        return [
          {
            type: "tool",
            name: String(event.part?.tool ?? "tool"),
            detail: summarizeInput(event.part?.state?.input),
          },
          { type: "tool-end" },
        ]
      case "error":
        return [{ type: "error", fatal: true, message: String(event.error?.message ?? "OpenCode failed") }]
      default:
        return []
    }
  },
}
