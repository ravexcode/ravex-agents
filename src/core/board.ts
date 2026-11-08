import { parseBlock, truncateResult } from "./blocks.ts"

export const MAX_TASKS_PER_GOAL = 12
export const MAX_REPLANS = 3
export const MAX_REVIEW_ROUNDS = 2
export const MAX_PARALLEL_TASKS = 4

export type TaskStatus = "proposed" | "todo" | "running" | "review" | "blocked" | "done" | "failed" | "cancelled"
export type BoardPhase = "idle" | "planning" | "proposed" | "running" | "paused" | "wrapping-up"

export interface TaskComment {
  author: string
  text: string
}

export interface Task {
  id: number
  title: string
  description: string
  assignee: string
  dependsOn: number[]
  /** Whether it may change files. Other tasks run read-only. */
  edits: boolean
  reviewer?: string
  reviewRounds: number
  status: TaskStatus
  comments: TaskComment[]
  result?: string
}

export interface Board {
  goal?: string
  phase: BoardPhase
  tasks: Task[]
  /** Existing tasks that the proposed plan would run again. */
  pendingRetry: number[]
  replans: number
  nextTaskId: number
}

export const EMPTY_BOARD: Board = { phase: "idle", tasks: [], pendingRetry: [], replans: 0, nextTaskId: 1 }

export interface ParsedPlan {
  /** The message without the block. */
  text: string
  tasks: Task[]
  retry: number[]
  error?: string
}

interface PlanContext {
  workers: Set<string>
  /** Team members whose tools let them change files. */
  editors?: Set<string>
  board: Board
}

function hasCycle(tasks: Task[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const finished = new Set<number>()
  const visit = (id: number, path: Set<number>): boolean => {
    if (path.has(id)) return true
    if (finished.has(id)) return false
    path.add(id)
    const cyclic = (byId.get(id)?.dependsOn ?? []).some((dependency) => visit(dependency, path))
    path.delete(id)
    finished.add(id)
    return cyclic
  }
  return tasks.some((task) => visit(task.id, new Set()))
}

/** Returns null when the message doesn't contain a plan. */
export function parsePlan(message: string, { workers, editors, board }: PlanContext): ParsedPlan | null {
  const block = parseBlock(message, "ravex-plan")
  if (!block) return null

  const invalid = (error: string): ParsedPlan => ({ text: block.text, tasks: [], retry: [], error })
  if (block.error) return invalid(block.error)

  const data = block.data as { tasks?: unknown; retry?: unknown } | null
  const items: unknown = data?.tasks ?? []
  const retry: unknown = data?.retry ?? []
  if (!Array.isArray(items)) return invalid('"tasks" must be a list.')
  if (!Array.isArray(retry) || !retry.every((id) => typeof id === "number")) {
    return invalid('"retry" must be a list of task numbers.')
  }
  if (items.length === 0 && retry.length === 0) return invalid("The plan has no tasks.")

  const unfinished = new Set<TaskStatus>(["blocked", "failed", "cancelled", "todo"])
  for (const id of retry as number[]) {
    const existing = board.tasks.find((task) => task.id === id)
    if (!existing || !unfinished.has(existing.status)) {
      return invalid(`Task ${id} can't be retried because it isn't an unfinished task.`)
    }
  }

  const keptCount = board.tasks.filter((task) => task.status === "done" || (retry as number[]).includes(task.id)).length
  if (keptCount + items.length > MAX_TASKS_PER_GOAL) {
    return invalid(`A goal can have at most ${MAX_TASKS_PER_GOAL} tasks; this plan would have ${keptCount + items.length}.`)
  }

  const keys = new Map<string, number>()
  items.forEach((item, position) => {
    const key = (item as { key?: unknown } | null)?.key
    if (typeof key === "string") keys.set(key, board.nextTaskId + position)
  })

  const tasks: Task[] = []
  for (const [position, raw] of items.entries()) {
    const item = raw as Record<string, unknown> | null
    const label = `Task ${position + 1}`
    if (typeof item?.title !== "string" || !item.title.trim()) return invalid(`${label} needs a "title".`)
    if (typeof item.description !== "string" || !item.description.trim()) {
      return invalid(`${label} needs a "description".`)
    }
    if (typeof item.agent !== "string" || !workers.has(item.agent)) {
      return invalid(`${label} is assigned to "${String(item.agent)}", who isn't an available team member.`)
    }
    if (item.edits === true && editors && !editors.has(item.agent)) {
      return invalid(`${label} changes files, but "${item.agent}" has no tools to do that.`)
    }
    let reviewer: string | undefined
    if (item.reviewer !== undefined && item.reviewer !== null) {
      if (typeof item.reviewer !== "string" || !workers.has(item.reviewer)) {
        return invalid(`${label} has "${String(item.reviewer)}" as reviewer, who isn't an available team member.`)
      }
      if (item.reviewer === item.agent) return invalid(`${label} can't be reviewed by its own assignee.`)
      reviewer = item.reviewer
    }

    const references: unknown = item.dependsOn ?? []
    if (!Array.isArray(references)) return invalid(`${label} has a "dependsOn" that isn't a list.`)
    const dependsOn: number[] = []
    for (const reference of references) {
      if (typeof reference === "string") {
        const id = keys.get(reference)
        if (id === undefined) return invalid(`${label} depends on unknown key "${reference}".`)
        dependsOn.push(id)
      } else if (typeof reference === "number") {
        const existing = board.tasks.find((task) => task.id === reference)
        if (!existing || (existing.status !== "done" && !(retry as number[]).includes(reference))) {
          return invalid(`${label} depends on task ${reference}, which isn't finished or being retried.`)
        }
        dependsOn.push(reference)
      } else {
        return invalid(`${label} has an invalid dependency.`)
      }
    }

    tasks.push({
      id: board.nextTaskId + position,
      title: item.title.trim(),
      description: item.description.trim(),
      assignee: item.agent,
      dependsOn,
      edits: item.edits === true,
      ...(reviewer ? { reviewer } : {}),
      reviewRounds: 0,
      status: "proposed",
      comments: [],
    })
  }

  if (hasCycle(tasks)) return invalid("The tasks' dependencies form a cycle.")
  return { text: block.text, tasks, retry: retry as number[] }
}

export type TaskRun = { task: Task; kind: "work" | "review"; agent: string }

/** Chooses what to start next, given the tasks already running. */
export function nextRuns(tasks: Task[], active: ReadonlyMap<number, string>, editBusy = false): TaskRun[] {
  const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id))
  const busyAgents = new Set(active.values())
  const byId = new Map(tasks.map((task) => [task.id, task]))
  // Every agent shares one folder, so two edits at once could overwrite each other.
  let editRunning = editBusy || [...active.keys()].some((id) => byId.get(id)?.status === "running" && byId.get(id)?.edits)
  let count = active.size

  const runs: TaskRun[] = []
  for (const task of tasks) {
    if (count >= MAX_PARALLEL_TASKS) break
    if (active.has(task.id)) continue

    if (task.status === "review" && task.reviewer) {
      if (busyAgents.has(task.reviewer)) continue
      busyAgents.add(task.reviewer)
      runs.push({ task, kind: "review", agent: task.reviewer })
      count++
    } else if (task.status === "todo" && task.dependsOn.every((id) => done.has(id))) {
      if (busyAgents.has(task.assignee) || (task.edits && editRunning)) continue
      busyAgents.add(task.assignee)
      editRunning ||= task.edits
      runs.push({ task, kind: "work", agent: task.assignee })
      count++
    }
  }
  return runs
}

export function hasUnresolved(tasks: Task[]): boolean {
  return tasks.some((task) => task.status === "todo" || task.status === "blocked" || task.status === "failed")
}

export interface WorkerReport {
  status: "done" | "blocked" | "review"
  text: string
  summary: string
  comment?: string
  room?: string
}

/** A worker that doesn't send a block is treated as finished, with its message as the result. */
export function parseWorkerReport(message: string): WorkerReport {
  const block = parseBlock(message, "ravex-task")
  if (!block) return { status: "done", text: message, summary: message }

  const data = block.data as Record<string, unknown> | null | undefined
  const status = data?.status === "blocked" || data?.status === "review" ? data.status : "done"
  const summary = typeof data?.summary === "string" && data.summary.trim() ? data.summary.trim() : block.text
  return {
    status,
    text: block.text,
    summary,
    ...(typeof data?.comment === "string" && data.comment.trim() ? { comment: data.comment.trim() } : {}),
    ...(typeof data?.room === "string" && data.room.trim() ? { room: data.room.trim() } : {}),
  }
}

/** What dependent tasks and the orchestrator receive. */
export function reportResult(report: WorkerReport): string {
  return report.text && report.summary !== report.text ? `${report.text}\n\nSummary: ${report.summary}` : report.summary
}

export interface ReviewVerdict {
  verdict: "approved" | "changes" | "none"
  text: string
  comment: string
}

/** Unlike a worker's report, a review without a verdict isn't assumed to be an approval. */
export function parseReview(message: string): ReviewVerdict {
  const block = parseBlock(message, "ravex-review")
  if (!block) return { verdict: "none", text: message, comment: message }

  const data = block.data as { verdict?: unknown; comment?: unknown } | null | undefined
  const verdict = data?.verdict === "approved" || data?.verdict === "changes" ? data.verdict : "none"
  const comment = typeof data?.comment === "string" && data.comment.trim() ? data.comment.trim() : block.text
  return { verdict, text: block.text, comment }
}

export interface RosterEntry {
  id: string
  description: string
  engine: string
  /** What it can use, such as "read, edit, web". */
  tools: string
  skills: string[]
}

export function buildOrchestratorInstructions(own: string, roster: RosterEntry[]): string {
  const team = roster.length
    ? roster
        .map((member) => {
          const skills = member.skills.length ? `; skills: ${member.skills.join(", ")}` : ""
          return `- ${member.id}: ${member.description || "General purpose"} (${member.engine}; tools: ${member.tools}${skills})`
        })
        .join("\n")
    : "(nobody is available)"

  return [
    own,
    `You are the orchestrator of a team of agents. You don't do the work yourself: you can read the project to plan, then you assign the work.\n\nYour team:\n${team}`,
    [
      "When the user gives you a goal that needs work, propose a plan by ending your message with exactly one block like this, with nothing after it:",
      "```ravex-plan",
      '{"tasks":[{"key":"audit","title":"Short title","description":"Everything the agent needs to know","agent":"<team member id>","dependsOn":[],"edits":false},{"key":"fix","title":"Short title","description":"...","agent":"<team member id>","dependsOn":["audit"],"edits":true,"reviewer":"<another team member id>"}]}',
      "```",
      `Rules: at most ${MAX_TASKS_PER_GOAL} tasks per goal. "dependsOn" lists keys from this plan or numbers of finished tasks. Dependent tasks receive the results of the tasks they depend on. Set "edits" to true only for tasks that must change files, because those run one at a time, and only for members with the edit or shell tool. Assign work to whoever has the tools and skills for it. "reviewer" is optional and makes another agent check the work. Agents can't see this conversation, so each description must stand on its own.`,
      "Your message ends at the block. The user approves the plan before anything runs.",
      'If tasks are blocked or failed, you can propose new tasks, and run existing ones again by adding "retry":[<task numbers>] to the block. Unfinished tasks that you leave out are cancelled.',
      "If the request doesn't need the team, just answer it without a block.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function buildWorkerInstructions(own: string, canEdit: boolean): string {
  return [
    own,
    [
      "You are working on one task as part of a team.",
      canEdit
        ? "You may change files in this task. Other agents may be reading the same folder."
        : 'This task is read-only: you can\'t change files. If it requires changes, report "status":"blocked" and say so.',
      "End your final message with exactly one block like this, with nothing after it:",
      "```ravex-task",
      '{"status":"done","summary":"What you did and what others need to know"}',
      "```",
      'Use "status":"blocked" and explain why in the summary if you can\'t continue without a decision or something you lack. Use "status":"review" if your work should be checked. You can also add "comment" to leave a note on the task, and "room" to post a message to the team room, where @id calls a teammate.',
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function buildReviewerInstructions(own: string): string {
  return [
    own,
    [
      "You are reviewing a teammate's task. You can read the project, but not change it.",
      "End your final message with exactly one block like this, with nothing after it:",
      "```ravex-review",
      '{"verdict":"approved","comment":"What you checked"}',
      "```",
      'Use "verdict":"changes" and list what must change in "comment" if the work isn\'t acceptable.',
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function buildRoomInstructions(own: string, teammates: string[]): string {
  return [
    own,
    `You are in a team room with the user and these teammates: ${teammates.join(", ")}. You were called because someone mentioned you. Reply briefly. Write @id only if you need that teammate to respond. You can read the project, but changes to files happen through tasks.`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

function formatComments(comments: TaskComment[]): string {
  return comments.map((comment) => `- ${comment.author}: ${comment.text}`).join("\n")
}

export function buildTaskPrompt(task: Task, board: Board, roomContext: string): string {
  const dependencies = task.dependsOn.flatMap((id) => {
    const dependency = board.tasks.find((candidate) => candidate.id === id)
    return dependency ? [`## Task ${id}: ${dependency.title} (${dependency.assignee})\n${truncateResult(dependency.result ?? "(no result)")}`] : []
  })

  return [
    `Team goal: ${board.goal ?? "(none)"}`,
    `Your task #${task.id}: ${task.title}\n${task.description}`,
    dependencies.length ? `Results from the tasks this depends on:\n\n${dependencies.join("\n\n")}` : "",
    task.comments.length ? `Comments on this task:\n${formatComments(task.comments)}` : "",
    roomContext ? `Recent messages in the team room:\n${roomContext}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function buildReviewPrompt(task: Task): string {
  return [
    `Review task #${task.id}: ${task.title}\n${task.description}`,
    `${task.assignee} reports:\n${truncateResult(task.result ?? "(no result)")}`,
    task.comments.length ? `Comments on this task:\n${formatComments(task.comments)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

function statusLine(task: Task): string {
  const summary = task.result ? `\n${truncateResult(task.result)}` : ""
  const comments = task.comments.length ? `\nComments:\n${formatComments(task.comments)}` : ""
  return `## Task ${task.id} (${task.status}): ${task.title}, by ${task.assignee}${summary}${comments}`
}

export function buildWrapUpPrompt(board: Board): string {
  return `Every task for the goal has finished. Summarize the outcome for the user.\n\n${board.tasks.filter((task) => task.status !== "cancelled").map(statusLine).join("\n\n")}`
}

export function buildIssuePrompt(board: Board): string {
  const issues = board.tasks.filter((task) => task.status === "blocked" || task.status === "failed")
  return [
    "Work has stopped because some tasks can't continue. Either propose a plan to resolve this, or explain to the user what you need from them.",
    `Blocked or failed:\n\n${issues.map(statusLine).join("\n\n")}`,
    `All tasks:\n${board.tasks.map((task) => `- ${task.id} ${task.status}: ${task.title}`).join("\n")}`,
  ].join("\n\n")
}

export function buildUserReplyPrompt(reply: string, board: Board): string {
  return [
    `The user says: ${reply}`,
    `Current tasks:\n${board.tasks.map((task) => `- ${task.id} ${task.status}: ${task.title} (${task.assignee})`).join("\n")}`,
    'Propose a plan if work should continue, using "retry" for tasks that should run again.',
  ].join("\n\n")
}

export function buildRunningChatPrompt(message: string, board: Board): string {
  return [
    `The user says: ${message}`,
    `Tasks are running, so answer without proposing a plan. Current tasks:\n${board.tasks.map((task) => `- ${task.id} ${task.status}: ${task.title} (${task.assignee})`).join("\n")}`,
  ].join("\n\n")
}

/** Interrupted work waits for the user, so that reopening the app never spends quota by itself. */
export function recoverBoard(board: Board): Board {
  const tasks = board.tasks.map((task): Task =>
    task.status === "running"
      ? {
          ...task,
          status: "todo",
          comments: [...task.comments, { author: "system", text: "Interrupted when Ravex closed." }],
        }
      : task,
  )
  const hasPlan = tasks.some((task) => task.status === "proposed") || board.pendingRetry.length > 0
  const hasPending = hasUnresolved(tasks) || tasks.some((task) => task.status === "review")
  return { ...board, tasks, phase: hasPlan ? "proposed" : hasPending ? "paused" : "idle" }
}

export function buildPlanErrorPrompt(error: string): string {
  return `Your plan wasn't accepted: ${error} Send a corrected ravex-plan block, or answer without one.`
}
