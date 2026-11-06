import { describe, expect, test } from "bun:test"
import { claude } from "./claude.ts"
import { codex } from "./codex.ts"
import { opencode } from "./opencode.ts"
import type { TurnRequest } from "./types.ts"

const line = (value: unknown) => JSON.stringify(value)

describe("buildArgs", () => {
  const base = { prompt: "-hi", cwd: "/project" }

  test("never lets a prompt be read as a flag", () => {
    for (const provider of [claude, codex, opencode]) {
      const args = provider.buildArgs({ ...base, mode: "read-only" })
      expect(args.slice(-2)).toEqual(["--", "-hi"])
    }
  })

  test("uses a read-only policy by default mode", () => {
    expect(claude.buildArgs({ ...base, mode: "read-only" })).toContain("dontAsk")
    expect(codex.buildArgs({ ...base, mode: "read-only" })).toContain('sandbox_mode="read-only"')
    expect(opencode.buildArgs({ ...base, mode: "read-only" }).join(" ")).toContain("--agent ravex-read-only")
  })

  test("never bypasses approvals in edit mode", () => {
    expect(claude.buildArgs({ ...base, mode: "edit" })).toContain("acceptEdits")
    expect(codex.buildArgs({ ...base, mode: "edit" })).toContain('sandbox_mode="workspace-write"')
    expect(opencode.buildArgs({ ...base, mode: "edit" }).join(" ")).toContain("--agent build")
    for (const provider of [claude, codex, opencode]) {
      const args = provider.buildArgs({ ...base, mode: "edit" }).join(" ")
      expect(args).not.toMatch(/bypass|danger|--auto/)
    }
  })

  test("resumes the existing session", () => {
    const request = { ...base, mode: "read-only" as const, sessionId: "abc" }
    expect(claude.buildArgs(request).join(" ")).toContain("--resume abc")
    expect(codex.buildArgs(request).slice(0, 2)).toEqual(["exec", "resume"])
    expect(codex.buildArgs(request).slice(-3)).toEqual(["abc", "--", "-hi"])
    expect(opencode.buildArgs(request).join(" ")).toContain("--session abc")
  })
})

describe("opencode read-only agent", () => {
  const env = (request: Partial<TurnRequest> = {}) =>
    opencode.buildEnv?.({ prompt: "hi", cwd: "/project", mode: "read-only", ...request })
  const config = (request?: Partial<TurnRequest>) => JSON.parse(env(request)?.OPENCODE_CONFIG_CONTENT ?? "{}")
  const agent = config().agent["ravex-read-only"]

  test("denies everything that isn't explicitly allowed", () => {
    expect(agent.permission["*"]).toBe("deny")
    expect(Object.keys(agent.permission).sort()).toEqual(["*", "glob", "grep", "list", "read"])
  })

  test("doesn't expose env files", () => {
    expect(agent.permission.read["*.env"]).toBe("deny")
    expect(agent.permission.read["*.env.*"]).toBe("deny")
  })

  test("applies instructions to the agent for the current mode, and keeps its permissions", () => {
    const readOnly = config({ instructions: "Be brief" }).agent["ravex-read-only"]
    expect(readOnly.prompt).toBe("Be brief")
    expect(readOnly.permission["*"]).toBe("deny")

    const edit = config({ instructions: "Be brief", mode: "edit" }).agent
    expect(edit.build.prompt).toBe("Be brief")
    expect(edit["ravex-read-only"].prompt).toBeUndefined()
  })

  test("leaves the agent's own prompt alone without instructions", () => {
    expect(config().agent["ravex-read-only"].prompt).toBeUndefined()
    expect(config({ mode: "edit" }).agent.build.prompt).toBeUndefined()
  })

  test("runs on a private server so that cancelling stops the work", () => {
    expect(opencode.buildArgs({ prompt: "hi", cwd: "/project", mode: "edit" })).toContain("--standalone")
  })
})

describe("agent settings", () => {
  const request = { prompt: "hi", cwd: "/project", mode: "read-only" as const, model: "m1", instructions: 'Say "x"\nnow' }

  test("pass the model to every CLI", () => {
    expect(claude.buildArgs(request).join(" ")).toContain("--model m1")
    expect(codex.buildArgs(request).join(" ")).toContain("-m m1")
    expect(opencode.buildArgs(request).join(" ")).toContain("-m m1")
  })

  test("pass instructions with their quotes and newlines intact", () => {
    const claudeArgs = claude.buildArgs(request)
    expect(claudeArgs[claudeArgs.indexOf("--append-system-prompt") + 1]).toBe(request.instructions)
    expect(codex.buildArgs(request)).toContain('developer_instructions="Say \\"x\\"\\nnow"')
  })

  test("add nothing when unset", () => {
    const plain = { prompt: "hi", cwd: "/project", mode: "read-only" as const }
    expect(claude.buildArgs(plain).join(" ")).not.toMatch(/--model|--append-system-prompt/)
    expect(codex.buildArgs(plain).join(" ")).not.toMatch(/ -m |developer_instructions/)
    expect(opencode.buildArgs(plain)).not.toContain("-m")
  })

  test("still end with the prompt on a resumed Codex session", () => {
    expect(codex.buildArgs({ ...request, sessionId: "abc" }).slice(-3)).toEqual(["abc", "--", "hi"])
  })
})

describe("claude.parseLine", () => {
  test("reads the session, streamed text and tools", () => {
    expect(claude.parseLine(line({ type: "system", subtype: "init", session_id: "s1" }))).toEqual([
      { type: "session", sessionId: "s1" },
    ])
    expect(
      claude.parseLine(
        line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } }),
      ),
    ).toEqual([{ type: "text-delta", text: "ok" }])
    expect(
      claude.parseLine(
        line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] } }),
      ),
    ).toEqual([{ type: "tool", name: "Read", detail: "a.ts" }])
  })

  test("ignores subagent output", () => {
    expect(
      claude.parseLine(
        line({
          type: "stream_event",
          parent_tool_use_id: "t1",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
        }),
      ),
    ).toEqual([])
  })

  test("reports failed results as fatal", () => {
    expect(claude.parseLine(line({ type: "result", is_error: true, result: "nope" }))).toEqual([
      { type: "error", fatal: true, message: "nope" },
    ])
    expect(claude.parseLine(line({ type: "result", is_error: false, result: "ok" }))).toEqual([])
  })
})

describe("codex.parseLine", () => {
  test("reads the thread and agent messages", () => {
    expect(codex.parseLine(line({ type: "thread.started", thread_id: "t1" }))).toEqual([
      { type: "session", sessionId: "t1" },
    ])
    expect(
      codex.parseLine(line({ type: "item.completed", item: { type: "agent_message", text: "ok" } })),
    ).toEqual([{ type: "text-start" }, { type: "text-delta", text: "ok" }])
    expect(
      codex.parseLine(line({ type: "item.started", item: { type: "command_execution", command: "ls" } })),
    ).toEqual([{ type: "tool", name: "shell", detail: "ls" }])
  })

  test("treats only turn.failed as fatal", () => {
    expect(codex.parseLine(line({ type: "error", message: "retrying" }))).toEqual([
      { type: "error", fatal: false, message: "retrying" },
    ])
    expect(codex.parseLine(line({ type: "turn.failed", error: { message: "revoked" } }))).toEqual([
      { type: "error", fatal: true, message: "revoked" },
    ])
  })
})

describe("opencode.parseLine", () => {
  test("reads the session, text, tools and errors", () => {
    expect(opencode.parseLine(line({ type: "step_start", sessionID: "s1" }))).toEqual([
      { type: "session", sessionId: "s1" },
    ])
    expect(opencode.parseLine(line({ type: "text", part: { text: "ok" } }))).toEqual([
      { type: "text-start" },
      { type: "text-delta", text: "ok" },
    ])
    expect(
      opencode.parseLine(
        line({ type: "tool_use", part: { tool: "read", state: { input: { path: "data.txt" } } } }),
      ),
    ).toEqual([{ type: "tool", name: "read", detail: "data.txt" }])
    expect(opencode.parseLine(line({ type: "error", error: { message: "Model unavailable" } }))).toEqual([
      { type: "error", fatal: true, message: "Model unavailable" },
    ])
  })
})

test("parsers ignore lines that aren't JSON objects", () => {
  for (const provider of [claude, codex, opencode]) {
    expect(provider.parseLine("not json")).toEqual([])
    expect(provider.parseLine("42")).toEqual([])
    expect(provider.parseLine("")).toEqual([])
  }
})
