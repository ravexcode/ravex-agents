import type { Agent } from "./types.ts"

export const MAX_TASKS_PER_ROUND = 8
export const MAX_RESULT_LENGTH = 20_000

// Only a block that ends the message counts, so that an agent can discuss or
// quote the format without triggering a delegation.
const DELEGATION_BLOCK = /```ravex-delegate[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/

export interface DelegationTask {
  agent: string
  task: string
}

export interface ParsedDelegation {
  /** The message without the block. */
  text: string
  tasks: DelegationTask[]
  error?: string
}

export interface DelegationResult {
  agent: string
  status: "done" | "failed" | "cancelled"
  output: string
}

export function buildInstructions(agent: Agent, subagents: Agent[]): string {
  if (subagents.length === 0) return agent.instructions

  const roster = subagents
    .map((subagent) => `- ${subagent.id}: ${subagent.description || subagent.name}`)
    .join("\n")

  return [
    agent.instructions,
    `You can delegate work to these specialist subagents:\n${roster}`,
    [
      "Each subagent starts with no knowledge of this conversation, so every task must stand on its own.",
      "This block is the only way to reach them. Your own agent or task tools can't, so don't try those first.",
      "To delegate, end your message with exactly one block like this, with nothing after it:",
      "```ravex-delegate",
      '{"tasks":[{"agent":"<subagent id>","task":"<the complete task>"}]}',
      "```",
      `You can list up to ${MAX_TASKS_PER_ROUND} tasks, which run in parallel. Your turn ends at the block, and you then receive every result in a new message, so you can delegate again or give your final answer.`,
      "Delegate only when a specialist would help. Otherwise, answer directly.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n")
}

/** Returns null when the message doesn't delegate. */
export function parseDelegation(message: string): ParsedDelegation | null {
  const match = DELEGATION_BLOCK.exec(message)
  if (!match) return null

  const text = message.slice(0, match.index).trimEnd()
  const invalid = (error: string): ParsedDelegation => ({ text, tasks: [], error })

  let data: unknown
  try {
    data = JSON.parse(match[1] ?? "")
  } catch {
    return invalid("The delegation block isn't valid JSON.")
  }

  const tasks = (data as { tasks?: unknown } | null)?.tasks
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return invalid('The delegation block needs a non-empty "tasks" list.')
  }
  const isTask = (task: unknown): task is DelegationTask => {
    const candidate = task as Partial<DelegationTask> | null
    return typeof candidate?.agent === "string" && typeof candidate.task === "string" && candidate.task.trim() !== ""
  }
  if (!tasks.every(isTask)) {
    return invalid('Every delegated task needs an "agent" and a non-empty "task".')
  }
  if (tasks.length > MAX_TASKS_PER_ROUND) {
    return invalid(`A delegation can have at most ${MAX_TASKS_PER_ROUND} tasks; this one has ${tasks.length}.`)
  }
  return { text, tasks }
}

function truncate(output: string): string {
  return output.length > MAX_RESULT_LENGTH
    ? `${output.slice(0, MAX_RESULT_LENGTH)}\n[Truncated: this result was over ${MAX_RESULT_LENGTH} characters.]`
    : output
}

export function formatResults(results: DelegationResult[]): string {
  const sections = results.map(
    (result) => `## ${result.agent} (${result.status})\n${truncate(result.output) || "(no output)"}`,
  )
  return [
    "Results from your subagents:",
    ...sections,
    "Continue from these results: delegate again if needed, or give your final answer.",
  ].join("\n\n")
}

export function formatDelegationError(error: string): string {
  return `Your delegation wasn't run: ${error} Fix the block and send it again, or give your final answer.`
}
